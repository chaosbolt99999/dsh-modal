/**
 * Project identity, durable local state, and lane locking.
 *
 * State lives outside the workspace (`$DSH_HOME/modal/<key>.json`) so the
 * plugin never writes into the repo it is building, and so a lane can be
 * reattached across harness restarts.
 *
 * @module dsh-modal/projects
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectState, SpendState } from './engine/types.js'

/** Directory holding all dsh-modal state. Honours `DSH_HOME` like the harness does. */
export function stateDirectory(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'modal')
}

/**
 * Stable identity for one workspace + toolchain pair.
 *
 * The key must not change between runs: the remote mirror path is derived from
 * it, and cargo fingerprints are path-sensitive, so a wandering path would
 * invalidate every cached artifact.
 * @param workspaceRoot - absolute path of the local workspace.
 * @param toolchain - resolved toolchain name.
 * @returns a 12-hex-character key.
 */
export function projectKey(workspaceRoot: string, toolchain: string): string {
  return createHash('sha256').update(`${workspaceRoot}\u0000${toolchain}`).digest('hex').slice(0, 12)
}

function statePath(key: string): string {
  return join(stateDirectory(), `${key}.json`)
}

/** An empty spend ledger. */
export function emptySpend(): SpendState {
  return { cpuCoreSeconds: 0, memGiBSeconds: 0, estimatedUsd: 0, commands: 0, lastCommandAt: 0 }
}

/**
 * Read or initialize a project's state.
 * @param key - the project key.
 * @param workspaceRoot - absolute workspace path, stored for diagnostics.
 * @param toolchain - toolchain name, stored so a toolchain switch is visible.
 * @returns the state, creating defaults when absent or unreadable.
 */
export async function readState(key: string, workspaceRoot: string, toolchain: string): Promise<ProjectState> {
  const path = statePath(key)
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as ProjectState
      if (parsed.version === 1 && Array.isArray(parsed.lanes)) {
        return { ...parsed, toolchain, spend: { ...emptySpend(), ...parsed.spend } }
      }
    } catch {
      // A corrupt state file must never block a build; fall through and rebuild it.
    }
  }
  return { version: 1, key, workspaceRoot, toolchain, lanes: [], spend: emptySpend() }
}

/**
 * Persist project state atomically, so a killed proxy cannot leave a truncated
 * file that would lose a lane or an image id.
 * @param state - the state to write.
 */
export async function writeState(state: ProjectState): Promise<void> {
  await mkdir(stateDirectory(), { recursive: true })
  const path = statePath(state.key)
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/**
 * Add one command's billing facts to the ledger.
 * @param state - state to mutate.
 * @param cpuCoreSeconds - core-seconds consumed, if known.
 * @param memGiBSeconds - GiB-seconds consumed, if known.
 */
export function recordSpend(state: ProjectState, cpuCoreSeconds: number, memGiBSeconds: number): void {
  const cost = cpuCoreSeconds * 0.00003942 + memGiBSeconds * 0.00000667
  state.spend.cpuCoreSeconds += cpuCoreSeconds
  state.spend.memGiBSeconds += memGiBSeconds
  state.spend.estimatedUsd += cost
  state.spend.commands += 1
  state.spend.lastCommandAt = Date.now()
}

function lockPath(key: string, index: number): string {
  return join(stateDirectory(), `${key}.lane${index}.lock`)
}

/** A held lane lock. */
export interface LaneLock {
  readonly index: number
  release(): Promise<void>
}

const LOCK_STALE_MS = 30 * 60 * 1000

/**
 * Try to take one lane's advisory lock.
 *
 * The lock is a `wx`-opened file holding the owner pid, so two proxies on the
 * same machine cannot drive one lane concurrently and collide on cargo's target
 * lock. A lock file older than {@link LOCK_STALE_MS} whose pid is gone is
 * treated as stale, so a killed proxy cannot wedge a lane forever.
 * @param key - the project key.
 * @param index - the lane index.
 * @returns the lock, or undefined when the lane is busy.
 */
export async function tryAcquireLane(key: string, index: number): Promise<LaneLock | undefined> {
  await mkdir(stateDirectory(), { recursive: true })
  const path = lockPath(key, index)
  try {
    const handle = await open(path, 'wx')
    await handle.writeFile(`${process.pid}\n`, 'utf8')
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const info = await stat(path).catch(() => undefined)
    if (info === undefined) return tryAcquireLane(key, index)
    const age = Date.now() - info.mtimeMs
    const owner = Number.parseInt((await readFile(path, 'utf8').catch(() => '')).trim(), 10)
    const alive = Number.isInteger(owner) && owner > 0 && (() => {
      try {
        process.kill(owner, 0)
        return true
      } catch {
        return false
      }
    })()
    if (age > LOCK_STALE_MS || !alive) {
      await unlink(path).catch(() => undefined)
      return tryAcquireLane(key, index)
    }
    return undefined
  }

  let released = false
  return {
    index,
    release: async () => {
      if (released) return
      released = true
      await unlink(path).catch(() => undefined)
    },
  }
}
