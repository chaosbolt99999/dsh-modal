/**
 * Tests for the pure engine pieces: path translation, config resolution, sync
 * planning, and the guard's argument extraction. Everything here is
 * network-free, so it runs in CI.
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig, DEFAULT_REMOTE, DEFAULT_ROUTING } from '../src/config.ts'
import { planSync, type SourceManifest } from '../src/engine/sync.ts'
import { shellJoin, translateArgv, translatePath } from '../src/engine/paths.ts'
import { commandOf } from '../src/guard.ts'
import { promptText } from '../src/prompt.ts'
import { readWorkspaceScript } from '../src/script.ts'
import { projectKey, emptySpend } from '../src/projects.ts'

describe('config resolution', () => {
  it('applies documented defaults', () => {
    const { routing, remote } = resolveConfig({})
    expect(routing).toEqual(DEFAULT_ROUTING)
    expect(remote.cpu).toBe(DEFAULT_REMOTE.cpu)
    expect(remote.lanes).toBe(2)
    expect(remote.maxLanesPerProject).toBe(3)
    expect(remote.idleTimeoutMs).toBe(120_000)
  })

  it('rejects an unknown enum with a readable message', () => {
    expect(() => resolveConfig({ routing: { mode: 'yolo' } as never })).toThrow(/routing\.mode must be one of/)
    expect(() => resolveConfig({ remote: { compute: 'lambda' } as never })).toThrow(/remote\.compute must be one of/)
  })

  it('never lets the lane cap fall below the lane count', () => {
    const { remote } = resolveConfig({ remote: { lanes: 4, maxLanesPerProject: 2 } })
    expect(remote.maxLanesPerProject).toBe(4)
  })

  it('clamps the lane count into a sane range', () => {
    expect(resolveConfig({ remote: { lanes: 99 } }).remote.lanes).toBe(8)
    expect(resolveConfig({ remote: { lanes: 0 } }).remote.lanes).toBe(1)
  })

  it('carries an explicit workspace root through for layer 3', () => {
    expect(resolveConfig({ remote: { workspaceRoot: '/w' } as never }).remote.workspaceRoot).toBe('/w')
    expect(resolveConfig({}).remote.workspaceRoot).toBeUndefined()
  })
})

describe('path translation', () => {
  const root = '/home/u/proj'
  const mappings = [{ from: '/home/u/.cargo', to: '/cache/cargo' }]

  it('maps the workspace root itself', () => {
    expect(translatePath(root, root, mappings)).toEqual({ ok: true, value: '/work/src' })
  })

  it('maps a path under the workspace root', () => {
    expect(translatePath(`${root}/crates/kernel`, root, mappings)).toEqual({ ok: true, value: '/work/src/crates/kernel' })
  })

  it('maps a configured prefix', () => {
    expect(translatePath('/home/u/.cargo/registry', root, mappings)).toEqual({ ok: true, value: '/cache/cargo/registry' })
  })

  it('leaves relative paths alone', () => {
    expect(translatePath('crates/kernel', root, mappings)).toEqual({ ok: true, value: 'crates/kernel' })
  })

  it('REFUSES an unmapped absolute path rather than guessing', () => {
    const result = translatePath('/home/u/other/proj', root, mappings)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('path-outside-workspace')
  })

  it('does not treat a workspace-name prefix as containment', () => {
    // /home/u/proj-other must NOT be swallowed by the /home/u/proj prefix.
    expect(translatePath('/home/u/proj-other', root, mappings).ok).toBe(false)
  })

  it('translates --flag=/path forms', () => {
    const result = translateArgv(['cargo', `--manifest-path=${root}/Cargo.toml`], root, mappings)
    expect(result).toEqual({ ok: true, argv: ['cargo', '--manifest-path=/work/src/Cargo.toml'] })
  })

  it('allows system paths through untouched', () => {
    const result = translateArgv(['/usr/bin/cargo', 'test'], root, mappings)
    expect(result).toEqual({ ok: true, argv: ['/usr/bin/cargo', 'test'] })
  })

  it('refuses a whole argv when one entry cannot be translated', () => {
    const result = translateArgv(['cargo', 'test', '--manifest-path', '/elsewhere/Cargo.toml'], root, mappings)
    expect(result.ok).toBe(false)
  })
})

describe('shell quoting', () => {
  it('leaves safe words bare', () => {
    expect(shellJoin(['cargo', 'test', '-p', 'kernel'])).toBe('cargo test -p kernel')
  })
  it('quotes words with spaces and quotes', () => {
    expect(shellJoin(['echo', 'a b', "it's"])).toBe(`echo 'a b' 'it'\\''s'`)
  })
  it('quotes the empty string', () => {
    expect(shellJoin(['x', ''])).toBe("x ''")
  })
})

describe('sync planning', () => {
  const manifest = (files: Record<string, [number, number]>): SourceManifest => ({ files, syncedAt: 0 })

  it('is a full upload on a first sync', () => {
    const plan = planSync(undefined, manifest({ 'a.rs': [1, 1] }))
    expect(plan.full).toBe(true)
    expect(plan.changed).toEqual(['a.rs'])
  })

  it('reports nothing when nothing moved', () => {
    const plan = planSync(manifest({ 'a.rs': [1, 1] }), manifest({ 'a.rs': [1, 1] }))
    expect(plan.changed).toEqual([])
    expect(plan.deleted).toEqual([])
  })

  it('detects a size change and an mtime-only change', () => {
    const plan = planSync(manifest({ 'a.rs': [1, 1], 'b.rs': [5, 5] }), manifest({ 'a.rs': [2, 1], 'b.rs': [5, 9] }))
    expect(plan.changed.sort()).toEqual(['a.rs', 'b.rs'])
  })

  it('detects additions and deletions', () => {
    const plan = planSync(manifest({ 'gone.rs': [1, 1] }), manifest({ 'new.rs': [1, 1] }))
    expect(plan.changed).toEqual(['new.rs'])
    expect(plan.deleted).toEqual(['gone.rs'])
  })
})

describe('guard argument extraction', () => {
  it('reads a bash command argument', () => {
    expect(commandOf({ command: 'cargo test' })).toBe('cargo test')
  })
  it('ignores calls without a command', () => {
    expect(commandOf({ path: '/x' })).toBeUndefined()
    expect(commandOf(null)).toBeUndefined()
    expect(commandOf('cargo test')).toBeUndefined()
    expect(commandOf({ command: 42 })).toBeUndefined()
  })
})

describe('prompt section', () => {
  it('explains routing and both overrides', () => {
    const text = promptText(DEFAULT_ROUTING, DEFAULT_REMOTE)
    expect(text).toContain('DSH_MODAL=0')
    expect(text).toContain('DSH_MODAL=force')
    expect(text).toContain('cargo')
    expect(text).toContain('stay local')
  })
  it('contributes nothing when routing is off', () => {
    expect(promptText({ ...DEFAULT_ROUTING, mode: 'off' }, DEFAULT_REMOTE)).toBe('')
  })
})

describe('project identity', () => {
  it('is stable for the same workspace and toolchain', () => {
    expect(projectKey('/a/b', 'rust')).toBe(projectKey('/a/b', 'rust'))
  })
  it('separates different workspaces and toolchains', () => {
    expect(projectKey('/a/b', 'rust')).not.toBe(projectKey('/a/c', 'rust'))
    expect(projectKey('/a/b', 'rust')).not.toBe(projectKey('/a/b', 'node'))
  })
  it('is a short path-safe token', () => {
    expect(projectKey('/a/b', 'rust')).toMatch(/^[0-9a-f]{12}$/)
  })
  it('starts with an empty ledger', () => {
    expect(emptySpend()).toMatchObject({ commands: 0, estimatedUsd: 0 })
  })
})

describe('workspace script reading', () => {
  // The classifier follows a script only when it can be run against the mirror,
  // which is exactly the set of files contained by the workspace root.
  const root = process.cwd()

  it('reads a file inside the workspace', () => {
    expect(readWorkspaceScript('package.json', root)).toContain('dsh-modal')
  })

  it('refuses an absolute path outside the workspace', () => {
    expect(readWorkspaceScript('/etc/passwd', root)).toBeUndefined()
  })

  it('refuses a sibling directory that merely shares the prefix', () => {
    // Containment, not a string prefix: `/w-other` must not pass for `/w`.
    expect(readWorkspaceScript(`${root}-other/script.sh`, root)).toBeUndefined()
  })

  it('refuses a missing file', () => {
    expect(readWorkspaceScript('definitely-not-here.sh', root)).toBeUndefined()
  })

  it('refuses a directory', () => {
    expect(readWorkspaceScript('src', root)).toBeUndefined()
  })

  it('refuses a path that escapes the workspace', () => {
    expect(readWorkspaceScript('../outside.sh', root)).toBeUndefined()
  })
})
