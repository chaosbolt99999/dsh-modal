/**
 * Dist-level smoke check for the classifier fixes.
 *
 * The unit tests exercise `src/`, so this confirms the emitted `dist/` behaves
 * the same — the class of bug where source and build drift apart.
 */
import { classify, beforeHeredoc } from '../dist/classify.js'

const cases = [
  ['cargo test --manifest-path .spike-rust/Cargo.toml', 'remote'],
  ['cargo --version', 'local'],
  ['cargo --version && rustc --version', 'local'],
  ['cargo --version && cargo --version --verbose | head -2', 'local'],
  ['cargo test && cargo fmt', 'deny'],
  ['cargo build && cargo --version', 'deny'],
  ['cargo fmt', 'local'],
  ['wc -l src/classify.ts && grep -c describe tests/classify.spec.ts', 'local'],
  ["cat > notes.md <<'EOF'\nrun cargo test here\nEOF", 'local'],
  ['ls -la crates', 'local'],
]

let failures = 0
for (const [command, expected] of cases) {
  const actual = classify(command).route
  const verdict = actual === expected ? 'ok  ' : 'FAIL'
  if (actual !== expected) failures += 1
  process.stdout.write(`${verdict} ${expected.padEnd(7)} got ${actual.padEnd(7)} ${JSON.stringify(command)}\n`)
}

process.stdout.write(`\nbeforeHeredoc: ${JSON.stringify(beforeHeredoc("cat <<EOF\nbody\nEOF"))}\n`)
process.stdout.write(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILURE(S)\n`)
process.exitCode = failures === 0 ? 0 : 1
