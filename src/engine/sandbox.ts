/**
 * Sandbox lifecycle and the cache tiers.
 *
 *   T1 warm lane   — reattach the live sandbox; `target/` is on local NVMe and
 *                    nothing crosses the network.
 *   T2 checkpoint  — `snapshotDirectory(target)` -> `Image`. An Image is a
 *                    LOCAL DISK layer, not a network filesystem, so cargo's
 *                    small-file churn never touches a Volume. Restored with
 *                    `mountImage` on the next cold start.
 *   T3 toolchain home — a Volume for the download cache (registry, git), which
 *                    is genuinely write-once/read-mostly and safe to share
 *                    across lanes.
 *   T4 baked image — the toolchain image itself, built once per project.
 *
 * @module dsh-modal/engine/sandbox
 */

import type { ModalClient } from 'modal'
import { buildToolchainImage, recipeFor, type ToolchainRecipe } from './images.js'
import { REMOTE_SOURCE_ROOT } from './sync.js'
import type { LaneAcquisition, LaneState, ProjectState, RemoteSettings } from './types.js'

type Sandbox = Awaited<ReturnType<ModalClient['sandboxes']['create']>>
type App = Awaited<ReturnType<ModalClient['apps']['fromName']>>
type Image = Awaited<ReturnType<ModalClient['images']['fromRegistry']>>

/** A sandbox ready to run one command, and how it was obtained. */
export interface SandboxHandle {
  readonly sandbox: Sandbox
  readonly lane: number
  readonly acquisition: LaneAcquisition
  readonly recipe: ToolchainRecipe
}

/** Per-lane `target/` path. Separate per lane so parallel agents cannot collide. */
export function laneTargetPath(lane: number): string {
  return `/work/target-lane${lane}`
}

/** Create the Modal client from the launch environment or `~/.modal.toml`. */
export async function createModalClient(): Promise<ModalClient> {
  const { ModalClient } = await import('modal')
  return new ModalClient()
}

async function volumeFor(modal: ModalClient, recipe: ToolchainRecipe): Promise<Record<string, unknown>> {
  // The download cache is the one thing that genuinely suits a Volume: content
  // addressed, written once, read many. `target/` deliberately does not go here.
  try {
    const volume = await modal.volumes.fromName(`dsh-modal-cache-${recipe.name}`, { createIfMissing: true })
    return { [recipe.cacheHome]: volume }
  } catch {
    // A workspace without Volume support still works; the registry is just
    // re-downloaded after a cold start. Never fail a build over the cache.
    return {}
  }
}

/** Whether a recorded sandbox is still alive. */
async function isAlive(modal: ModalClient, sandboxId: string): Promise<Sandbox | undefined> {
  try {
    const sandbox = await modal.sandboxes.fromId(sandboxId)
    const exit = await sandbox.poll()
    return exit === null ? sandbox : undefined
  } catch {
    return undefined
  }
}

/**
 * Choose a lane for this command.
 *
 * Lanes already held by another live proxy are skipped, so two agents building
 * concurrently use different sandboxes and never contend on cargo's target lock.
 * @param state - project state.
 * @param settings - resolved remote settings.
 * @param isBusy - predicate reporting whether a lane is locked elsewhere.
 * @returns the chosen lane index.
 */
export function chooseLane(state: ProjectState, settings: RemoteSettings, isBusy: (index: number) => boolean): number {
  const existing = [...state.lanes].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  for (const lane of existing) {
    if (!isBusy(lane.index)) return lane.index
  }
  for (let index = 0; index < settings.maxLanesPerProject; index += 1) {
    if (!state.lanes.some(lane => lane.index === index) && !isBusy(index)) return index
  }
  // Every lane is busy: reuse the least recently used one rather than refusing.
  return existing[existing.length - 1]?.index ?? 0
}

function newestTargetImage(state: ProjectState, excludeLane: number): string | undefined {
  const candidates = state.lanes
    .filter(lane => lane.index !== excludeLane && lane.targetImageId !== undefined)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  return candidates[0]?.targetImageId
}

/** Options for {@link openSandbox}. */
export interface OpenOptions {
  readonly modal: ModalClient
  readonly app: App
  readonly state: ProjectState
  readonly settings: RemoteSettings
  readonly lane: number
  /** Force a fresh sandbox, ignoring any recorded one. */
  readonly fresh?: boolean
  readonly log?: (message: string) => void
}

/**
 * Reattach or create the sandbox for one lane.
 * @param options - client, state, and lane selection.
 * @returns the handle, tagged with which tier served it.
 */
export async function openSandbox(options: OpenOptions): Promise<SandboxHandle> {
  const { modal, app, state, settings, lane } = options
  const log = options.log ?? ((): void => {})
  const { recipe } = recipeFor(settings.toolchain)
  const record = state.lanes.find(entry => entry.index === lane)

  // T1: a live sandbox from a previous command in this session.
  if (options.fresh !== true && record?.sandboxId !== undefined) {
    const alive = await isAlive(modal, record.sandboxId)
    if (alive !== undefined) {
      log(`reattached warm sandbox ${record.sandboxId}`)
      return { sandbox: alive, lane, acquisition: 'warm', recipe }
    }
  }

  const { image } = await buildToolchainImage(modal, app, recipe, settings)

  // T2: seed from the newest checkpoint in ANY lane, so a fresh lane starts warm.
  let seed: Image | undefined
  const seedId = record?.targetImageId ?? newestTargetImage(state, lane)
  if (seedId !== undefined) {
    try {
      seed = await modal.images.fromId(seedId)
      log(`restoring target from checkpoint image ${seedId}`)
    } catch {
      log(`checkpoint image ${seedId} is gone; starting cold`)
    }
  }

  const volumes = await volumeFor(modal, recipe)
  const sandbox = await modal.sandboxes.create(app, image, {
    cpu: settings.cpu,
    memoryMiB: settings.memoryMiB,
    timeoutMs: settings.timeoutMs,
    idleTimeoutMs: settings.idleTimeoutMs,
    workdir: REMOTE_SOURCE_ROOT,
    env: { ...recipe.env, ...settings.env, ...(Object.keys(volumes).length > 0 ? { HOME: '/root' } : {}) },
    ...(Object.keys(volumes).length > 0 ? { volumes: volumes as never } : {}),
  })

  if (seed !== undefined) {
    try {
      await sandbox.mountImage(laneTargetPath(lane), seed)
    } catch (error) {
      log(`could not mount checkpoint: ${(error as Error).message}`)
    }
  }

  await sandbox.exec(['mkdir', '-p', REMOTE_SOURCE_ROOT, laneTargetPath(lane)], { mode: 'text' }).then(p => p.wait())

  return { sandbox, lane, acquisition: seed === undefined ? 'cold' : 'restored', recipe }
}

/**
 * Checkpoint a lane's `target/` into an Image.
 *
 * Never throws: a checkpoint is an optimization, and failing a completed build
 * because its cache could not be saved would be the wrong trade.
 * @param handle - the live sandbox.
 * @param state - project state, updated in place with the new image id.
 * @param ttlMs - how long the resulting Image should live.
 * @returns the image id, when the checkpoint succeeded.
 */
export async function checkpointTarget(
  handle: SandboxHandle,
  state: ProjectState,
  ttlMs: number | null = null,
): Promise<string | undefined> {
  try {
    const image = await handle.sandbox.snapshotDirectory(laneTargetPath(handle.lane), { ttlMs, timeoutMs: 10 * 60 * 1000 })
    const lane = state.lanes.find(entry => entry.index === handle.lane)
    if (lane !== undefined) lane.targetImageId = image.imageId
    return image.imageId
  } catch {
    return undefined
  }
}

/**
 * Upsert a lane record from a live handle.
 * @param state - project state, mutated in place.
 * @param handle - the live sandbox.
 */
export function rememberLane(state: ProjectState, handle: SandboxHandle): void {
  const existing = state.lanes.find(entry => entry.index === handle.lane)
  if (existing !== undefined) {
    existing.sandboxId = handle.sandbox.sandboxId
    existing.lastUsedAt = Date.now()
    return
  }
  const record: LaneState = { index: handle.lane, sandboxId: handle.sandbox.sandboxId, lastUsedAt: Date.now() }
  state.lanes.push(record)
}

/**
 * Terminate a sandbox, ignoring failures — Modal may already have reaped it.
 * @param handle - the sandbox to stop.
 */
export async function closeSandbox(handle: SandboxHandle): Promise<void> {
  await handle.sandbox.terminate().catch(() => undefined)
}
