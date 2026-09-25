/**
 * End-to-end verification of the built plugin against real Modal.
 *
 * The running harness holds the plugin module in memory, so a change to `dist/`
 * cannot be exercised through the `bash` tool until a restart. This script does
 * exactly what `ModalBashExecutor.resolve()` does — classify (with the real
 * script-reading hook), build the proxy command line, run it as an ordinary
 * local process — so the engine can be verified without one.
 *
 * It creates a throwaway Rust crate in the workspace plus a shell script that
 * builds it, routes both a direct `cargo test` and `bash <script>` through the
 * proxy, and removes the fixtures afterwards.
 *
 * Requires Modal credentials in the environment (`MODAL_TOKEN_ID` /
 * `MODAL_TOKEN_SECRET`, or `~/.modal.toml`):
 *
 *   MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… node spike/dist-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, DEFAULT_ROUTING } from '../dist/classify.js'
import { readWorkspaceScript } from '../dist/script.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const fixture = join(root, '.spike-rust')
const scriptRel = '.spike-rust/run-tests.sh'
const directCommand = 'cargo test --manifest-path .spike-rust/Cargo.toml'
const scriptCommand = `bash ${scriptRel}`

const settings = {
  toolchain: 'rust',
  cpu: 2,
  memoryMiB: 4096,
  timeoutMs: 1_800_000,
  idleTimeoutMs: 120_000,
  lanes: 2,
  maxLanesPerProject: 3,
  onLaneExhausted: 'queue',
  compute: 'sandbox',
  excludes: ['target', '.git', 'node_modules'],
  laneWaitMs: 600_000,
  aptPackages: [],
  env: {},
  cpuPricePerCoreSecond: 0.00003942,
  memPricePerGiBSecond: 0.00000667,
}

/** The hook the executor passes, pointed at the real filesystem. */
const hooks = { cwd: root, readWorkspaceFile: readWorkspaceScript }

function report(label, ok) {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`)
  return ok
}

function runProxy(command) {
  const b64 = value => Buffer.from(value, 'utf8').toString('base64')
  return new Promise(done => {
    const child = spawn(
      process.execPath,
      [resolve(root, 'bin/exec.js'), '--command-b64', b64(command), '--settings-b64', b64(JSON.stringify(settings))],
      { cwd: root, stdio: 'inherit' },
    )
    child.on('exit', code => done(code ?? 1))
  })
}

// Fixtures first: the script check needs the file to exist to be read.
await mkdir(join(fixture, 'src'), { recursive: true })
await writeFile(
  join(fixture, 'Cargo.toml'),
  '[package]\nname = "modal-smoke"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
  'utf8',
)
await writeFile(
  join(fixture, 'src/lib.rs'),
  'pub fn shout(text: &str) -> String { text.to_uppercase() }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn uppercases() { assert_eq!(shout("hello"), "HELLO"); }\n}\n',
  'utf8',
)
await writeFile(join(fixture, 'run-tests.sh'), '#!/bin/sh\nset -e\ncargo test --manifest-path .spike-rust/Cargo.toml\n', 'utf8')

const checks = [
  report(`${JSON.stringify(directCommand)} routes remote`, classify(directCommand, DEFAULT_ROUTING, hooks).route === 'remote'),
  report(`${JSON.stringify(scriptCommand)} routes remote (script followed)`, classify(scriptCommand, DEFAULT_ROUTING, hooks).route === 'remote'),
  report('the same script WITHOUT hooks stays local', classify(scriptCommand).route === 'local'),
  report('a script outside the workspace stays local', classify('bash /tmp/outside.sh', DEFAULT_ROUTING, hooks).route === 'local'),
  report('tsc stays local', classify('tsc -b').route === 'local'),
  report('vitest stays local', classify('vitest run').route === 'local'),
  report('pytest stays local', classify('pytest -q').route === 'local'),
  report('cargo fmt stays local', classify('cargo fmt').route === 'local'),
  report('a script that writes stays local', classify(`bash ${scriptRel}`, { ...DEFAULT_ROUTING, remote: DEFAULT_ROUTING.remote }, {
    cwd: root,
    readWorkspaceFile: () => 'cargo clippy --fix\n',
  }).route === 'local'),
  report('compound build is refused', classify('cargo test && cargo fmt').route === 'deny'),
]

if (checks.includes(false)) {
  await rm(fixture, { recursive: true, force: true })
  process.stdout.write('\n[run] classify checks failed; fixtures removed\n')
  process.exit(1)
}

process.stdout.write('\n[run] 1/2 direct cargo test through the proxy...\n\n')
const directCode = await runProxy(directCommand)

process.stdout.write('\n[run] 2/2 the same build behind a workspace script...\n\n')
const scriptCode = await runProxy(scriptCommand)

await rm(fixture, { recursive: true, force: true })
process.stdout.write(`\n[run] direct exit ${directCode}, via-script exit ${scriptCode} (fixtures removed)\n`)
process.exit(directCode === 0 && scriptCode === 0 ? 0 : 1)
