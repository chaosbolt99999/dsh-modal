/**
 * Classifier tests. This is the highest-value suite in the plugin: every
 * silent-divergence and OOM-on-the-vps failure mode is a classification bug.
 */

import { describe, expect, it } from 'vitest'
import { classify, DEFAULT_ROUTING, scan, type RoutingConfig } from '../src/classify.ts'

const route = (command: string, config: RoutingConfig = DEFAULT_ROUTING): string => classify(command, config).route
const reason = (command: string, config: RoutingConfig = DEFAULT_ROUTING): string => classify(command, config).reason

describe('read-only inspection stays local', () => {
  // The requirement that motivated the namespace rule: agents inspect the repo
  // constantly, and none of that may become a network round trip.
  const local = [
    'ls -la crates',
    'cat README.md',
    'sed -n "1,80p" docs/design.md',
    'head -40 AGENTS.md',
    'tail -20 app-suite.log',
    'grep -rn "fn main" crates/',
    'rg --files crates',
    'wc -l crates/kernel/src/lib.rs',
    'find crates -name "*.rs" | head',
    'git log --oneline -20',
    'git status --porcelain',
    'git diff --stat',
    'pwd',
    'which cargo',
    'cargo --version',
    'jq ".version" package.json',
    'tree -L 2 crates',
  ]
  for (const command of local) {
    it(command, () => expect(route(command)).toBe('local'))
  }
})

describe('build programs route remote', () => {
  const remote = [
    'cargo test -p quantum-kernel',
    'cargo build --release',
    'cargo check -p quantum-app',
    'cargo clippy --workspace --all-targets -- -D warnings',
    'cargo nextest run -p quantum-kernel',
    'cargo metadata --no-deps',
    'rustc --edition 2021 crates/x.rs',
    'cargo test -p quantum-app --test layout',
  ]
  for (const command of remote) {
    it(command, () => expect(route(command)).toBe('remote'))
  }
})

describe('the common real-world shape: build piped into a read-only filter', () => {
  // Agents write this constantly, so it must route rather than fall back.
  it('routes a cargo test through tail', () => {
    expect(route('cargo test -p quantum-app --test layout 2>&1 | tail -60')).toBe('remote')
  })
  it('routes through head', () => {
    expect(route('cargo test | head -100')).toBe('remote')
  })
  it('routes through grep', () => {
    expect(route('cargo clippy --all-targets 2>&1 | grep -E "^(error|warning)"')).toBe('remote')
  })
  it('keeps a local inspection pipeline local', () => {
    expect(route('grep -rn "TODO" crates/ | wc -l')).toBe('local')
  })
  it('refuses an unsafe trailing stage', () => {
    // `tee` writes a file, so the pipeline is not read-only.
    expect(route('cargo test | tee out.txt')).toBe('deny')
    expect(reason('cargo test | tee out.txt')).toBe('unsafe-pipeline-stage')
  })
})

describe('write hazards are forced local regardless of config', () => {
  const hazards = [
    'cargo fmt',
    'cargo fix --allow-dirty',
    'cargo clippy --fix',
    'cargo add serde',
    'cargo new mycrate',
    'cargo remove foo',
    'insta review',
  ]
  for (const command of hazards) {
    it(command, () => expect(route(command)).toBe('local'))
  }
  it('still routes the read-only form of fmt', () => {
    expect(route('cargo fmt --check')).toBe('remote')
  })
})

describe('unroutable build commands fail closed', () => {
  it('denies a compound command containing a build', () => {
    expect(route('cargo test && cargo fmt')).toBe('deny')
    expect(reason('cargo test && cargo fmt')).toBe('compound-command')
  })
  it('denies a build with redirection', () => {
    expect(route('cargo test > /tmp/out.log')).toBe('deny')
  })
  it('denies a build with command substitution', () => {
    expect(route('cargo test $(cat args.txt)')).toBe('deny')
  })
  it('denies a build inside a subshell', () => {
    expect(route('(cd crates && cargo test)')).toBe('deny')
  })
  it('a compound command with no build stays local', () => {
    expect(route('cd crates && ls')).toBe('local')
  })
  it('falls back to local when policy says so', () => {
    const auto: RoutingConfig = { ...DEFAULT_ROUTING, onUnroutable: 'local' }
    expect(route('cargo test && cargo fmt', auto)).toBe('local')
    expect(reason('cargo test && cargo fmt', auto)).toBe('compound-command-fell-back')
  })
})

describe('remote path namespace', () => {
  // `target/` exists only in the mirror, so inspecting it must go where the
  // build ran even though the program itself is read-only.
  it('routes a read of target/', () => {
    expect(route('ls -la target/debug')).toBe('remote')
    expect(reason('ls -la target/debug')).toBe('remote-path-namespace')
  })
  it('routes a cat of a build artifact', () => {
    expect(route('cat target/debug/.fingerprint/x/output')).toBe('remote')
  })
  it('does not route an unrelated path', () => {
    expect(route('cat crates/kernel/src/lib.rs')).toBe('local')
  })
})

describe('escape hatches', () => {
  it('honours the env prefix', () => {
    expect(route('DSH_MODAL=0 cargo test')).toBe('local')
    expect(reason('DSH_MODAL=0 cargo test')).toBe('escape-hatch')
  })
  it('honours env-prefixed form', () => {
    expect(route('env DSH_MODAL=off cargo test')).toBe('local')
  })
  it('turns everything local when routing is off', () => {
    const off: RoutingConfig = { ...DEFAULT_ROUTING, mode: 'off' }
    expect(route('cargo test', off)).toBe('local')
    expect(reason('cargo test', off)).toBe('routing-off')
  })
  it('honours configured forced-local prefixes', () => {
    const cfg: RoutingConfig = { ...DEFAULT_ROUTING, forcedLocal: ['cargo test'] }
    expect(route('cargo test -p x', cfg)).toBe('local')
    expect(reason('cargo test -p x', cfg)).toBe('configured-forced-local')
  })
})

describe('scan', () => {
  it('ignores operators inside quotes', () => {
    const { tokens, unsafe } = scan('grep -rn "a && b" crates/')
    expect(unsafe).toBe(false)
    expect(tokens.some(t => t.kind === 'op' && t.value === '&&')).toBe(false)
  })
  it('flags unbalanced quotes', () => {
    expect(scan('grep "unterminated').unsafe).toBe(true)
  })
  it('flags backtick substitution', () => {
    expect(scan('echo `date`').unsafe).toBe(true)
  })
  it('flags command substitution inside double quotes', () => {
    expect(scan('echo "$(date)"').unsafe).toBe(true)
  })
  it('normalises an absolute program path', () => {
    expect(classify('/usr/local/bin/cargo test').route).toBe('remote')
  })
})
