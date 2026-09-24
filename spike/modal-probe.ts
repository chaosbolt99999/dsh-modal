/**
 * M0 spike: prove the three Modal primitives the design depends on.
 *
 *   1. A sandbox boots and `exec` streams stdout/stderr incrementally.
 *   2. The real exit code survives the round trip (including a non-zero one).
 *   3. `snapshotDirectory` -> `Image` -> `mountImage` persists a directory
 *      across containers WITHOUT a network filesystem. This is the cache
 *      design's load-bearing claim: an Image is a local-disk layer, so cargo's
 *      `target/` never has to live on a Volume.
 *
 * Not a test suite — a probe. Run with:
 *   node --experimental-strip-types spike/modal-probe.ts
 */

import { ModalClient } from 'modal'

const APP_NAME = 'dsh-modal-probe'

function stamp(message: string): void {
  process.stdout.write(`[probe] ${message}\n`)
}

const modal = new ModalClient()

stamp('resolving app')
const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true })
stamp(`app = ${app.appId}`)

// A tiny image keeps the probe cheap; the toolchain image is a project concern.
const image = modal.images.fromRegistry('debian:bookworm-slim')

stamp('creating sandbox')
const sandbox = await modal.sandboxes.create(app, image, {
  cpu: 2,
  memoryMiB: 2048,
  timeoutMs: 5 * 60 * 1000,
  idleTimeoutMs: 60 * 1000,
  workdir: '/work',
})
stamp(`sandbox = ${sandbox.sandboxId}`)

try {
  // ---- 1 + 2: streaming and exit-code fidelity -----------------------------
  stamp('exec: streaming probe')
  const proc = await sandbox.exec(
    ['bash', '-c', 'for i in 1 2 3; do echo "line $i"; sleep 0.2; done; echo "to stderr" 1>&2; exit 3'],
    { mode: 'text' },
  )

  let stdout = ''
  let stderr = ''
  const pumpOut = (async () => { for await (const chunk of proc.stdout) { stdout += String(chunk); stamp(`  stdout chunk: ${JSON.stringify(String(chunk))}`) } })()
  const pumpErr = (async () => { for await (const chunk of proc.stderr) { stderr += String(chunk) } })()
  const code = await proc.wait()
  await Promise.all([pumpOut, pumpErr])

  stamp(`exit code = ${code} (expected 3)`)
  stamp(`stdout = ${JSON.stringify(stdout)}`)
  stamp(`stderr = ${JSON.stringify(stderr)}`)
  if (code !== 3) throw new Error(`exit code fidelity broken: got ${code}`)

  // ---- 3: the cache primitive ---------------------------------------------
  stamp('snapshotDirectory probe')
  await sandbox.exec(['bash', '-c', 'mkdir -p /work/target/debug && echo "warm cache marker" > /work/target/debug/marker.txt'], { mode: 'text' }).then(p => p.wait())

  const snapshotImage = await sandbox.snapshotDirectory('/work/target', { ttlMs: 10 * 60 * 1000 })
  stamp(`snapshot image = ${snapshotImage.imageId}`)

  // A SECOND sandbox, with no shared filesystem, must see the directory.
  stamp('creating second sandbox mounting the snapshot')
  const second = await modal.sandboxes.create(app, image, {
    cpu: 1,
    memoryMiB: 1024,
    timeoutMs: 2 * 60 * 1000,
    workdir: '/work',
  })
  try {
    await second.mountImage('/work/target', snapshotImage)
    const read = await second.exec(['cat', '/work/target/debug/marker.txt'], { mode: 'text' })
    let text = ''
    for await (const chunk of read.stdout) text += String(chunk)
    await read.wait()
    stamp(`read back from mounted snapshot = ${JSON.stringify(text.trim())}`)
    if (!text.includes('warm cache marker')) throw new Error('snapshot round trip lost the directory')
    stamp('CACHE PRIMITIVE VERIFIED: snapshotDirectory -> mountImage persists across containers')
  } finally {
    await second.terminate()
  }
} finally {
  await sandbox.terminate()
  stamp('sandboxes terminated')
}

stamp('PROBE OK')
