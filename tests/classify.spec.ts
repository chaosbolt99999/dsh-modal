/**
 * Classifier tests. This is the highest-value suite in the plugin: every
 * silent-divergence and OOM-on-the-vps failure mode is a classification bug.
 */

import { describe, expect, it } from 'vitest'
import { beforeHeredoc, classify, DEFAULT_ROUTING, scan, type RoutingConfig } from '../src/classify.ts'

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

describe('capability probes are never treated as builds', () => {
  // Real-session bug: `cargo --version && cargo --version --verbose | head -2`
  // was refused as a compound build command. Checking whether a tool exists is
  // ordinary inspection and must stay local and cheap.
  it('keeps a compound line of probes local', () => {
    expect(route('cargo --version && rustc --version')).toBe('local')
    expect(reason('cargo --version && rustc --version')).toBe('capability-probe-in-compound')
  })
  it('keeps the exact shape that failed in a live session', () => {
    expect(route('cargo --version && cargo --version --verbose | head -2')).toBe('local')
  })
  it('treats a switch run containing a probe flag as a probe', () => {
    expect(route('cargo --version --verbose')).toBe('local')
    expect(route('rustc -V -v')).toBe('local')
  })
  it('still refuses a compound line containing a real build', () => {
    expect(route('cargo build && cargo --version')).toBe('deny')
    expect(route('cargo --version && cargo build')).toBe('deny')
  })
  it('still refuses the canonical mixed line', () => {
    expect(route('cargo test && cargo fmt')).toBe('deny')
  })
  it('keeps a compound of non-build inspection local', () => {
    expect(route('cd crates && ls')).toBe('local')
    expect(route('wc -l src/classify.ts && grep -c describe tests/classify.spec.ts')).toBe('local')
  })
  it('a probe carrying a real argument is not a probe', () => {
    expect(route('cargo --version test')).toBe('remote')
  })
})

describe('heredoc bodies are data, not shell syntax', () => {
  // Second real-session bug: writing a file whose BODY mentions a build tool was
  // refused, because the body was scanned as if it were the command itself.
  it('ignores a heredoc body when classifying', () => {
    expect(route("cat > notes.md <<'EOF'\nrun cargo test here\nEOF")).toBe('local')
  })
  it('ignores a heredoc body that would otherwise look like a hazard', () => {
    expect(route("cat > notes.md <<'EOF'\nalways cargo fmt before committing\nEOF")).toBe('local')
  })
  it('still classifies the command before the heredoc', () => {
    expect(route("cargo test <<'EOF'\ninput\nEOF")).toBe('remote')
  })
  it('exposes the truncation for testing', () => {
    expect(beforeHeredoc('cat <<EOF\nbody\nEOF')).toBe('cat ')
    expect(beforeHeredoc('cargo test')).toBe('cargo test')
  })
})

describe('rust is the only routed toolchain', () => {
  // Node and Python build trees are small enough that a network round trip buys
  // little, so they are deliberately NOT on the remote list. Locking this down
  // stops a later edit from quietly widening what leaves the machine.
  const local = ['tsc -b', 'tsc --noEmit', 'vitest run', 'npx vitest run', 'pnpm test', 'pytest -q', 'mypy src/', 'python -m pytest']
  for (const command of local) {
    it(`${command} stays local`, () => expect(route(command)).toBe('local'))
  }

  it('is the documented default policy', () => {
    expect([...DEFAULT_ROUTING.remote].sort()).toEqual(['cargo', 'rustc'])
  })

  it('still routes the Rust programs', () => {
    expect(route('cargo test')).toBe('remote')
    expect(route('rustc --edition 2021 x.rs')).toBe('remote')
  })

  it('a configured list can widen it again', () => {
    const widened: RoutingConfig = { ...DEFAULT_ROUTING, remote: [...DEFAULT_ROUTING.remote, 'tsc'] }
    expect(route('tsc -b', widened)).toBe('remote')
  })
})

describe('a workspace script that builds is routed with it', () => {
  // Without this, `bash build.sh` compiles locally and unnoticed: the shape
  // analysis cannot see inside the file, and the guard cannot catch it either
  // because the program is `bash`, not `cargo`.
  const files: Record<string, string> = {
    'build.sh': '#!/usr/bin/env bash\nset -e\ncargo test --workspace\n',
    'absolute.sh': '#!/bin/sh\n/usr/local/bin/rustc --edition 2021 x.rs\n',
    'quiet.sh': '#!/bin/sh\necho nothing to build here\nls -la\n',
    'writes.sh': '#!/bin/sh\ncargo clippy --fix\n',
    'wrapped.sh': '#!/bin/sh\n./cargo-fmt-wrapper.sh\n',
  }
  const hooks = { cwd: '/w', readWorkspaceFile: (path: string) => files[path] }

  it('routes a workspace script that invokes a build', () => {
    const verdict = classify('bash build.sh', DEFAULT_ROUTING, hooks)
    expect(verdict.route).toBe('remote')
    expect(verdict.reason).toBe('workspace-script-invokes-build')
  })

  it('routes through sh as well as bash', () => {
    expect(classify('sh build.sh', DEFAULT_ROUTING, hooks).route).toBe('remote')
  })

  it('recognises an absolute path to a build tool', () => {
    expect(classify('bash absolute.sh', DEFAULT_ROUTING, hooks).route).toBe('remote')
  })

  it('keeps a script with no build in it local', () => {
    expect(classify('bash quiet.sh', DEFAULT_ROUTING, hooks).route).toBe('local')
  })

  it('keeps a script that WRITES the tree local', () => {
    const verdict = classify('bash writes.sh', DEFAULT_ROUTING, hooks)
    expect(verdict.route).toBe('local')
    expect(verdict.reason).toBe('script-contains-write-hazard')
  })

  it('does not match a build name inside a longer word', () => {
    expect(classify('bash wrapped.sh', DEFAULT_ROUTING, hooks).route).toBe('local')
  })

  it('stays local when the script cannot be read', () => {
    const unreadable = { cwd: '/w', readWorkspaceFile: () => undefined }
    expect(classify('bash /tmp/outside.sh', DEFAULT_ROUTING, unreadable).route).toBe('local')
  })

  it('stays local with no hooks at all', () => {
    expect(classify('bash build.sh').route).toBe('local')
  })

  it('ignores inline source, which is not a file', () => {
    expect(classify('bash -c "cargo test"', DEFAULT_ROUTING, hooks).route).toBe('local')
  })

  it('leaves a direct build unaffected', () => {
    expect(classify('cargo test', DEFAULT_ROUTING, hooks).route).toBe('remote')
  })
})
