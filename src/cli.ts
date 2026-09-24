/**
 * The proxy: the program `ModalBashExecutor.resolve` invokes in place of a
 * routed build command.
 *
 * It runs as an ordinary LOCAL process through the inherited shell path, which
 * is what lets the parent executor keep owning sandboxing, deadlines, output
 * caps, spill files and background job semantics. Its only job is to move the
 * work across the network and report faithfully:
 *
 *   resolve lane -> reattach/create sandbox -> delta sync -> exec -> stream -> exit code
 *
 * @module dsh-modal/cli
 */

import { tryAcquireLane, projectKey, readState, recordSpend, writeState } from './projects.js'
import { createModalClient, checkpointTarget, chooseLane, laneTargetPath, openSandbox, rememberLane, type SandboxHandle } from './engine/sandbox.js'
import { recipeFor } from './engine/images.js'
import { applyDelta, buildManifest, createDeltaArchive, planSync, REMOTE_SOURCE_ROOT } from './engine/sync.js'
import type { ProjectState, RemoteSettings } from './engine/types.js'

interface Args {
  command: string
  settings: RemoteSettings
  laneAffinity?: string
  fresh: boolean
  flush: boolean
  json: boolean
}

function fail(message: string): never {
  process.stderr.write(`[dsh-modal] ${message}\n`)
  process.exit(70)
}

function decode(encoded: string | undefined, what: string): string {
  if (encoded === undefined) fail(`missing --${what}`)
  try {
    return Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    fail(`--${what} is not valid base64`)
  }
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? undefined : argv[index + 1]
  }
  const has = (name: string): boolean => argv.includes(`--${name}`)

  const command = decode(get('command-b64'), 'command-b64')
  const settingsRaw = decode(get('settings-b64'), 'settings-b64')
  let settings: RemoteSettings
  try {
    settings = JSON.parse(settingsRaw) as RemoteSettings
  } catch {
    return fail('--settings-b64 is not valid JSON')
  }
  const affinity = get('lane-affinity')
  return {
    command,
    settings,
    ...(affinity !== undefined && affinity !== '' ? { laneAffinity: affinity } : {}),
    fresh: has('fresh'),
    flush: has('flush'),
    json: has('json'),
  }
}

/** One lane index preferred by an affinity key, so an agent keeps its cache. */
function preferredLane(affinity: string | undefined, lanes: number): number | undefined {
  if (affinity === undefined) return undefined
  let hash = 0
  for (const ch of affinity) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash % lanes
}

async function acquireLane(
  key: string,
  settings: RemoteSettings,
  affinity: string | undefined,
  state: Parameters<typeof chooseLane>[0],
): Promise<{ index: number; release: () => Promise<void> }> {
  const preferred = preferredLane(affinity, settings.lanes)
  const order: number[] = []
  if (preferred !== undefined) order.push(preferred)
  order.push(chooseLane(state, settings, () => false))
  for (let index = 0; index < settings.maxLanesPerProject; index += 1) order.push(index)

  const deadline = Date.now() + settings.laneWaitMs
  let announced = false
  for (;;) {
    for (const index of new Set(order)) {
      const lock = await tryAcquireLane(key, index)
      if (lock !== undefined) return { index, release: lock.release }
    }
    if (settings.onLaneExhausted === 'fail') fail('every lane is busy and remote.onLaneExhausted is "fail"')
    if (Date.now() > deadline) fail(`waited ${Math.round(settings.laneWaitMs / 1000)}s for a free lane`)
    if (!announced) {
      process.stderr.write(`[dsh-modal] all ${settings.lanes} lane(s) busy; waiting for a lane to free up...\n`)
      announced = true
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

/** Rewrite local workspace paths so absolute references resolve in the mirror. */
function rewritePaths(command: string, workspaceRoot: string): string {
  if (workspaceRoot === '' || workspaceRoot === '/') return command
  return command.split(workspaceRoot).join(REMOTE_SOURCE_ROOT)
}

async function streamTo(target: NodeJS.WriteStream, stream: AsyncIterable<string | Uint8Array>): Promise<number> {
  let bytes = 0
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    bytes += text.length
    target.write(text)
  }
  return bytes
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const workspaceRoot = process.cwd()
  const { settings } = args
  const { recipe, known } = recipeFor(settings.toolchain)
  if (!known) process.stderr.write(`[dsh-modal] unknown toolchain "${settings.toolchain}"; using the generic recipe\n`)

  const key = projectKey(workspaceRoot, settings.toolchain)
  const state = await readState(key, workspaceRoot, settings.toolchain)
  state.toolchain = settings.toolchain

  if (args.settings.monthlyBudgetUsd !== undefined && state.spend.estimatedUsd > args.settings.monthlyBudgetUsd) {
    fail(
      `monthly budget of $${args.settings.monthlyBudgetUsd.toFixed(2)} is exhausted ` +
        `(estimated $${state.spend.estimatedUsd.toFixed(2)}). Raise cost.monthlyBudgetUsd or run with DSH_MODAL=0.`,
    )
  }

  const lane = await acquireLane(key, settings, args.laneAffinity, state)
  const started = Date.now()
  let handle: SandboxHandle | undefined
  let completed = false
  try {
    const modal = await createModalClient()
    const app = await modal.apps.fromName('dsh-modal', { createIfMissing: true })

    handle = await openSandbox({
      modal,
      app,
      state,
      settings,
      lane: lane.index,
      ...(args.fresh ? { fresh: true } : {}),
      log: message => process.stderr.write(`[dsh-modal] ${message}\n`),
    })
    rememberLane(state, handle)

    // --- delta sync ---------------------------------------------------------
    const syncStarted = Date.now()
    const manifest = await buildManifest(workspaceRoot, settings.excludes)
    const plan = planSync(handle.acquisition === 'warm' ? state.manifest : undefined, manifest)
    const delta = await createDeltaArchive(workspaceRoot, plan)
    const uploaded = await applyDelta(handle.sandbox, REMOTE_SOURCE_ROOT, delta)

    if (args.flush) {
      const image = await checkpointTarget(handle, state)
      await writeState(state)
      process.stdout.write(`[dsh-modal] checkpoint ${image ?? 'failed'}\n`)
      return
    }

    // --- execute ------------------------------------------------------------
    const target = laneTargetPath(lane.index)
    const env: Record<string, string> = {
      ...recipe.env,
      ...settings.env,
      ...(recipe.buildOutputEnv !== undefined ? { [recipe.buildOutputEnv]: target } : {}),
    }

    process.stdout.write(
      `[dsh-modal] project=${key} lane=${lane.index} toolchain=${recipe.name} cache=${handle.acquisition} ` +
        `sync=${uploaded} file(s) in ${Date.now() - syncStarted}ms sandbox=${handle.sandbox.sandboxId}\n`,
    )

    const proc = await handle.sandbox.exec(['bash', '-c', rewritePaths(args.command, workspaceRoot)], {
      workdir: REMOTE_SOURCE_ROOT,
      env,
      mode: 'text',
      timeoutMs: settings.timeoutMs,
    })

    // `ContainerProcess` exposes no kill primitive, so cancelling a remote
    // command means terminating its sandbox. The lane is rebuilt from its
    // checkpoint image on the next command, so this costs a restore, not work.
    const onSignal = (signal: NodeJS.Signals): void => {
      process.stderr.write(`[dsh-modal] ${signal}: terminating sandbox ${handle?.sandbox.sandboxId ?? ''}\n`)
      void handle?.sandbox.terminate().catch(() => undefined)
    }
    const handlers: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    for (const signal of handlers) process.once(signal, onSignal)

    const [, , exitCode] = await Promise.all([
      streamTo(process.stdout, proc.stdout),
      streamTo(process.stderr, proc.stderr),
      proc.wait(),
    ])
    for (const signal of handlers) process.removeListener(signal, onSignal)

    // --- bookkeeping --------------------------------------------------------
    state.manifest = manifest
    const elapsedSeconds = (Date.now() - started) / 1000
    recordSpend(state, elapsedSeconds * settings.cpu, (elapsedSeconds * settings.memoryMiB) / 1024)

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          exitCode,
          lane: lane.index,
          acquisition: handle.acquisition,
          sandboxId: handle.sandbox.sandboxId,
          uploaded,
          elapsedMs: Date.now() - started,
          spendUsd: state.spend.estimatedUsd,
        })}\n`,
      )
    }

    await writeState(state)
    completed = true
    process.exitCode = exitCode
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[dsh-modal] ${message}\n`)
    process.exitCode = 70
  } finally {
    // Checkpoint only after a command actually ran: a sync or setup failure has
    // nothing worth saving, and snapshotting is expensive.
    if (handle !== undefined && completed) await checkpointIfDue(handle, state, Date.now() - started)
    // Always release, or a crash would wedge the lane until the stale-lock sweep
    // notices the dead pid.
    await lane.release()
  }
}

/**
 * Checkpoint a lane's cache when it is worth the cost.
 *
 * Snapshotting a multi-gigabyte `target/` is expensive, so this is gated on the
 * command actually having done build work (elapsed time) and on the previous
 * checkpoint being stale. A rapid edit/test loop therefore stays on T1 and never
 * pays for a snapshot, while an unsupervised session still leaves a restore
 * point behind for the next cold start.
 */
async function checkpointIfDue(handle: SandboxHandle, state: ProjectState, elapsedMs: number): Promise<void> {
  if (elapsedMs < 20_000) return
  const lane = state.lanes.find(entry => entry.index === handle.lane)
  if (lane === undefined) return
  if (lane.targetImageId !== undefined && Date.now() - (lane.lastCheckpointAt ?? 0) < 900_000) return
  const image = await checkpointTarget(handle, state)
  if (image === undefined) return
  lane.lastCheckpointAt = Date.now()
  process.stderr.write(`[dsh-modal] checkpointed target -> ${image}\n`)
  await writeState(state).catch(() => undefined)
}

process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`[dsh-modal] unhandled rejection: ${String(reason)}\n`)
  process.exit(70)
})

// Guarded so the module can be imported by tests without executing a command.
if (process.env.DSH_MODAL_IMPORT_ONLY === undefined) {
  void main().catch((error: unknown) => {
    process.stderr.write(`[dsh-modal] fatal: ${String(error)}\n`)
    process.exit(70)
  })
}

export { main, parseArgs, preferredLane, rewritePaths }
