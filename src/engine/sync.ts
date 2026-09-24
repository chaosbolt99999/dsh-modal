/**
 * Source synchronization: a git-first manifest and a changed-files-only delta.
 *
 * Changed-files-only is a correctness requirement, not an optimization. Cargo
 * fingerprints are mtime-based, so re-writing an unchanged file perturbs its
 * mtime and invalidates that crate's cached artifacts — the mirror would then
 * rebuild work that had not changed, on every single command.
 *
 * @module dsh-modal/engine/sync
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import type { FileStamp, SourceManifest } from './types.js'

const run = promisify(execFile)

/** Where the mirrored workspace lives inside the sandbox. */
export const REMOTE_SOURCE_ROOT = '/work/src'
/** Where the remote `target/` lives (a per-lane path is derived from this). */
export const REMOTE_TARGET_ROOT = '/work/target'

/** One planned sync. */
export interface SyncPlan {
  /** New or modified files, relative to the workspace root. */
  readonly changed: readonly string[]
  /** Paths present remotely but gone locally. */
  readonly deleted: readonly string[]
  /** Whether a full upload is required because no usable manifest exists. */
  readonly full: boolean
}

function isExcluded(relPath: string, excludes: readonly string[]): boolean {
  const segments = relPath.split('/')
  return segments.some(segment => excludes.includes(segment))
}

/**
 * List source files, preferring git.
 *
 * `git ls-files` respects `.gitignore` for free and never walks the huge
 * directories the excludes are there to skip, which matters on a repo whose
 * `target/` is tens of gigabytes.
 * @param root - absolute workspace root.
 * @returns relative paths, or undefined when the workspace is not a git repo.
 */
export async function gitFiles(root: string): Promise<string[] | undefined> {
  try {
    const [tracked, untracked] = await Promise.all([
      run('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 }),
      run('git', ['-C', root, 'ls-files', '-z', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 }),
    ])
    const split = (out: string): string[] => out.split('\u0000').filter(p => p !== '')
    return [...new Set([...split(tracked.stdout), ...split(untracked.stdout)])]
  } catch {
    return undefined
  }
}

/**
 * List source files by walking the tree, skipping excluded segments.
 * @param root - absolute workspace root.
 * @param excludes - path segments to skip entirely.
 * @returns relative paths.
 */
export async function walkFiles(root: string, excludes: readonly string[]): Promise<string[]> {
  const out: string[] = []
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (excludes.includes(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) await visit(abs)
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  await visit(root)
  return out
}

/**
 * Build a manifest of every source file's size and mtime.
 *
 * Files that vanish between listing and stat are skipped rather than failing the
 * command: a concurrent editor must never break a build.
 * @param root - absolute workspace root.
 * @param excludes - path segments to skip.
 * @returns the manifest.
 */
export async function buildManifest(root: string, excludes: readonly string[]): Promise<SourceManifest> {
  const listed = (await gitFiles(root)) ?? (await walkFiles(root, excludes))
  const files: Record<string, FileStamp> = {}
  for (const rel of listed) {
    if (isExcluded(rel, excludes)) continue
    const info = await stat(join(root, rel)).catch(() => undefined)
    if (info === undefined || !info.isFile()) continue
    files[rel] = [info.size, info.mtimeMs]
  }
  return { files, syncedAt: Date.now() }
}

/**
 * Compare the remote mirror's manifest against the current tree.
 * @param previous - what the mirror held, or undefined for a first sync.
 * @param next - the current manifest.
 * @returns the plan.
 */
export function planSync(previous: SourceManifest | undefined, next: SourceManifest): SyncPlan {
  if (previous === undefined) {
    return { changed: Object.keys(next.files), deleted: [], full: true }
  }
  const changed: string[] = []
  for (const [path, stamp] of Object.entries(next.files)) {
    const before = previous.files[path]
    if (before === undefined || before[0] !== stamp[0] || before[1] !== stamp[1]) changed.push(path)
  }
  const deleted = Object.keys(previous.files).filter(path => next.files[path] === undefined)
  return { changed, deleted, full: false }
}

/** A built archive ready to upload, plus what to delete remotely. */
export interface DeltaArchive {
  /** gzip-compressed tar of the changed files, or undefined when nothing changed. */
  readonly bytes?: Buffer
  readonly deleted: readonly string[]
  readonly count: number
}

/**
 * Pack the changed files into one gzip tar.
 *
 * A single archive rather than per-file writes: the sandbox filesystem API is
 * one round trip per call, so a large first sync would otherwise be thousands
 * of round trips. `tar` also preserves mtimes, which is what cargo reads.
 * @param root - absolute workspace root.
 * @param plan - the sync plan.
 * @returns the archive bytes and the deletion list.
 */
export async function createDeltaArchive(root: string, plan: SyncPlan): Promise<DeltaArchive> {
  if (plan.changed.length === 0) return { deleted: plan.deleted, count: 0 }

  const dir = await mkdtemp(join(tmpdir(), 'dsh-modal-sync-'))
  try {
    const listFile = join(dir, 'files')
    const archive = join(dir, 'delta.tar.gz')
    // NUL-separated: a filename may contain anything but NUL.
    await writeFile(listFile, `${plan.changed.join('\u0000')}\u0000`, 'utf8')
    // GNU tar's options are positional: `-C` must precede the file list or it
    // is reported as having no effect and the command fails.
    await run('tar', ['-C', root, '-czf', archive, '--null', '--files-from', listFile], {
      maxBuffer: 8 * 1024 * 1024,
    })
    const bytes = await readFile(archive)
    return { bytes, deleted: plan.deleted, count: plan.changed.length }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * The sandbox surface the sync path needs. Declared structurally rather than by
 * importing the SDK type so the module stays unit-testable with a fake.
 */
export interface RemoteSandbox {
  filesystem: { writeBytes(data: Uint8Array, remotePath: string): Promise<void> }
  exec(command: string[], params?: { workdir?: string; mode?: 'text' }): Promise<{
    stdout: AsyncIterable<string | Uint8Array>
    wait(): Promise<number>
  }>
}

async function collect(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += String(chunk)
  return out
}

const REMOTE_ARCHIVE = '/tmp/dsh-modal-sync.tar.gz'

/**
 * Upload and apply a delta inside the sandbox.
 * @param sandbox - the live sandbox.
 * @param remoteRoot - the mirror root inside the sandbox.
 * @param delta - the archive and deletions from {@link createDeltaArchive}.
 * @returns the number of files uploaded.
 */
export async function applyDelta(
  sandbox: RemoteSandbox,
  remoteRoot: string,
  delta: DeltaArchive,
): Promise<number> {
  await sandbox.exec(['mkdir', '-p', remoteRoot], { mode: 'text' }).then(p => p.wait())

  if (delta.bytes !== undefined) {
    await sandbox.filesystem.writeBytes(delta.bytes, REMOTE_ARCHIVE)
    // `-m` ("do not extract file modified time") is load-bearing, not cosmetic.
    // Preserving the LOCAL mtime makes an extracted file look older than the
    // artifact the sandbox already compiled from it, because that artifact was
    // stamped with the REMOTE clock. Cargo then judges the stale artifact newer
    // and silently skips the rebuild. Extraction time is the only mtime that is
    // consistent with the clock cargo compares against.
    const extract = await sandbox.exec(['tar', '-xz', '-m', '-f', REMOTE_ARCHIVE, '-C', remoteRoot], { mode: 'text' })
    const code = await extract.wait()
    if (code !== 0) {
      throw new Error(`dsh-modal: remote extract failed (exit ${code}): ${await collect(extract.stdout)}`)
    }
  }

  if (delta.deleted.length > 0) {
    // Chunked so a mass deletion cannot exceed argv limits.
    for (let i = 0; i < delta.deleted.length; i += 200) {
      const batch = delta.deleted.slice(i, i + 200)
      const proc = await sandbox.exec(['rm', '-rf', '--', ...batch], { workdir: remoteRoot, mode: 'text' })
      await proc.wait()
    }
  }
  return delta.count
}
