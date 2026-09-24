/**
 * End-to-end verification of the built plugin against real Modal.
 *
 * The running harness holds the plugin module in memory, so a change to `dist/`
 * cannot be exercised through the `bash` tool until a restart. This script does
 * exactly what `ModalBashExecutor.resolve()` does — classify, build the proxy
 * command line, run it as an ordinary local process — so the engine can be
 * verified without one.
 *
 * It creates a throwaway Rust crate in the workspace, routes a real `cargo test`
 * at it, and removes the crate afterwards.
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
import { classify } from '../dist/classify.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const fixture = join(root, '.spike-rust')
const command = 'cargo test --manifest-path .spike-rust/Cargo.toml'

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

function report(label, ok) {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`)
  return ok
}

const checks = [
  report(`${JSON.stringify(command)} routes remote`, classify(command).route === 'remote'),
  report('tsc stays local', classify('tsc -b').route === 'local'),
  report('vitest stays local', classify('vitest run').route === 'local'),
  report('pytest stays local', classify('pytest -q').route === 'local'),
  report('cargo fmt stays local', classify('cargo fmt').route === 'local'),
  report('compound build is refused', classify('cargo test && cargo fmt').route === 'deny'),
]

if (checks.includes(false)) process.exit(1)

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
process.stdout.write('\n[run] routing a real cargo test through the proxy...\n\n')

const b64 = value => Buffer.from(value, 'utf8').toString('base64')
const child = spawn(
  process.execPath,
  [resolve(root, 'bin/exec.js'), '--command-b64', b64(command), '--settings-b64', b64(JSON.stringify(settings))],
  { cwd: root, stdio: 'inherit' },
)

child.on('exit', async code => {
  await rm(fixture, { recursive: true, force: true })
  process.stdout.write(`\n[run] proxy exit code: ${code} (fixture removed)\n`)
  process.exit(code ?? 1)
})
