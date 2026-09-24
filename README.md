# dsh-modal

Route a DeepSeek Harness agent's **compile, test and lint work to a Modal sandbox** — with a persistent build cache — while keeping reads, greps and edits local.

Built for the case where the harness runs on a small VPS and the project does not fit. The reference workload is a 12-crate Rust workspace whose `target/` is **58 GB** and whose `cargo test --workspace` **OOM-kills the linker** on the host. After this plugin, the host never links anything, and `target/` never exists locally.

```
agent: cargo test -p quantum-kernel
  │
  ├─ classifier ─── read-only? ──▶ runs locally (grep, wc, cat, git log, find)
  │                 build?     ──▶ Modal sandbox
  │                 unroutable?──▶ REFUSED, with instructions
  │
  └─ Modal sandbox:  synced source + warm target/ + N cores
```

## What it does

| | |
|---|---|
| **Routes** | `cargo build/check/test/clippy/nextest/doc`, `rustc` — and the same commands piped into `head`/`tail`/`grep`, which is how agents actually write them |
| **Keeps local** | every read-only command: `ls`, `cat`, `sed -n`, `grep`, `rg`, `wc`, `find`, `git log/status/diff`, `jq`, `tree`, `cargo --version` |
| **Forces local** | anything that *writes* the tree: `cargo fmt` (write form), `cargo fix`, `cargo clippy --fix`, `cargo add/new/init`, `insta review` |
| **Refuses** | a build command it cannot route safely (compound line, redirect, subshell, substitution) — rather than silently compiling on your machine |
| **Caches** | warm sandbox → directory-snapshot `Image` → toolchain download Volume → baked toolchain image |
| **Parallelism** | lanes: independent warm sandboxes per project so concurrent agents never collide on cargo's target lock |

Read-only work staying local is structural, not a heuristic: the remote set is a **positive allowlist of build programs**, and local is the default.

**Rust only, deliberately.** A cargo `target/` tree runs to tens of gigabytes and linking it is memory-bound, so moving it off a small host is worth a network round trip. Node and Python build trees are a fraction of that, so routing them buys little and only adds ways to be surprised. Adding a language later is two lines: a recipe in `engine/images.ts`, and its program in `routing.remote`.

## Install

No npm publish — this installs the same way other third-party DSH plugins do, by **linking**.

```sh
git clone https://github.com/chaosbolt99999/dsh-modal ~/dsh-modal
cd ~/dsh-modal
pnpm install
pnpm build                       # required: `link:` does NOT build or install for you

dsh plugin --profile web add link:$HOME/dsh-modal    # absolute path
```

Then restart the harness. `package.json` declares both a `dsh.bundle` layer (which replaces the bash executor) and a `dsh.client` half (the Settings card), so no manual composition edit is required.

Confirm it loaded: `bash` commands that build should print a `[dsh-modal] project=… lane=… cache=…` provenance line.

### Three install gotchas, learned the hard way

1. **Pin the harness packages.** npm's `latest` dist-tag for `@deepseek-ai/dsh-*` is stale (`0.0.1-rc.5`). An unpinned install pulls a build from the wrong era. `package.json` pins exact versions matching the harness you run; bump them together.
2. **pnpm 11 moved build approval** out of `package.json` into `pnpm-workspace.yaml` (`allowBuilds:`). `esbuild` must be allowed or the test runner cannot start; `node-pty` and `koffi` must be allowed because `LocalSubprocessRuntime` loads the PTY backend at import time.
3. **A plugin that emits with plain `tsc` needs `.js` ESM specifiers** in relative imports, not the `.ts` specifiers DSH's own packages use — those rely on a bundler rewriting them, and `allowImportingTsExtensions` is incompatible with emitting.

## Configuration

Row config (in a `cordis.patch.yml`), or live in **Settings → Plugins** via the card:

```yaml
- id: bash-sandbox
  disabled: true            # ctx.shell allows exactly one provider
- insert:
    - id: bash-modal
      name: 'dsh-modal'
      config:
        routing:
          mode: strict              # strict | auto | off
          onUnroutable: deny        # deny | local
          remote: ['cargo', 'rustc']
          remotePathPrefixes: ['target/']
        remote:
          toolchain: rust           # rust | generic (fallback)
          cpu: 2                    # request low; sandboxes burst
          memoryMiB: 24576
          idleTimeoutMs: 120000
          lanes: 2
          maxLanesPerProject: 3
          onLaneExhausted: queue    # queue | exhausted-ephemeral | fail
```

### Overrides in the shell

| Prefix | Effect |
|---|---|
| `DSH_MODAL=0 <cmd>` | run locally on purpose |
| `DSH_MODAL=force <cmd>` | send an unroutable line (compound/redirected) to the sandbox as-is |

Hazards still apply under `force`: a command that writes the tree always runs locally.

### Optional third layer

`ctx.shell` covers the `bash` tool completely. Other process surfaces — a PTY shell, a terminal tool, a language server — reach the machine through `ctx.subprocess` instead. To route those too, replace the row:

```yaml
- id: subprocess
  disabled: true
- insert:
    - id: subprocess-modal
      name: 'dsh-modal/subprocess'
```

It **routes** rather than forwards: only argv whose program is on the `remote` list is diverted, so `glob`/`grep` and language servers keep the local filesystem and their own path namespace. Absolute paths outside the workspace are refused rather than guessed. Set `remote.workspaceRoot` when the harness is not launched from the workspace — this layer has no session context.

## Cost

Modal bills `max(request, actual)` per core-second and GiB-second, with **no idle fees once a sandbox is terminated**.

| | $/hour alive | 120 s idle window |
|---|---|---|
| 8 cores / 32 GiB | $1.90 | $0.063 |
| **2 cores / 24 GiB (default)** | **$0.86** | **$0.029** |
| 1 core / 8 GiB | $0.33 | $0.011 |

Requesting **2 cores instead of 8 is the single biggest cost lever**: sandboxes burst above their request under load, so you pay for actual work either way, but idle time is ~4× cheaper. `idleTimeoutMs: 120_000` bounds the rest, and `snapshotDirectory` means a lane that goes cold is restored from local disk rather than rebuilt.

Cumulative spend is tracked per project in `$DSH_HOME/modal/<key>.json`.

## How the cache works

The key insight: **a Modal Image is a local-disk layer, not a network filesystem.** `snapshotDirectory()` → `Image` → `mountImage()` persists `target/` without a Volume, so cargo's small-file churn and `stat` storms never touch network storage. Volumes are used only for the download cache (registry, git), which is genuinely write-once/read-mostly.

| Tier | Mechanism | Serves |
|---|---|---|
| T1 | reattach the live sandbox (`idleTimeoutMs`) | rapid edit/test loops — zero transfer |
| T2 | `snapshotDirectory(target)` → `Image` → `mountImage` | cold start after a gap |
| T3 | Volume for `CARGO_HOME` | registry and git checkouts |
| T4 | toolchain image (apt + `cargo fetch`) | a project's very first run |

Source sync is **changed-files-only**, and that is a correctness requirement rather than an optimization: cargo fingerprints are mtime-based, so re-writing an unchanged file would invalidate that crate's artifacts on every command. Sync prefers `git ls-files` (respects `.gitignore`, never walks `target/`).

Two mtime details that are load-bearing:

- Extraction uses `tar -m`. Preserving the *local* mtime makes an extracted file look older than the artifact the sandbox compiled from it, because that artifact carries the *remote* clock — cargo then judges the stale artifact newer and silently skips the rebuild.
- Remote builds set `CARGO_TARGET_DIR` to a **per-lane** path, so parallel lanes cannot collide.

`CARGO_PROFILE_DEV_DEBUG=line-tables-only` is set remotely: for the reference workload that is 10.0 GB → 3.6 GB of test binaries, the difference between a 64 GB and a 16 GB container, while keeping `file:line` in backtraces.

## Limitations

- **macOS-only gates cannot move.** A gpui app's windowed and IME verification need macOS. Headless `cargo test`, clippy and `wasm32` gates do move.
- **The first run for a new project is slow** — it pays full dependency compilation and image build. T4 is the fix, once.
- **Enforcement is policy, not a security boundary.** DSH's own position is that plugins are not a security boundary. `onUnroutable: deny` plus `ctx.tools.guard()` reliably stops a *cooperative* agent from compiling locally and is auditable, but any plugin can still call `ctx.subprocess` directly.
- **Cancelling a remote command terminates its sandbox** — `ContainerProcess` exposes no kill primitive. The lane is rebuilt from its checkpoint, so it costs a restore, not work.
- **Remote commands run with network access and no `ctx.sandbox` confinement.** The local sandbox does not extend to Modal. Your source is uploaded to Modal — keep the workspace private.
- **The third layer needs `remote.workspaceRoot`** when the harness is not launched from the workspace.
- **Only Rust is supported.** The `rust` image mirrors a Linux CI runner's apt needs (X11/Wayland/keyboard libraries for gpui, a C toolchain for Loro and sqlite); adjust `remote.aptPackages` for a different dependency set, or add a recipe for another language. An unknown `toolchain` name falls back to a bare `generic` Debian image rather than failing the command.

## Development

```sh
pnpm install
pnpm typecheck     # host + client
pnpm test          # 96 network-free tests
pnpm build
```

The classifier in `src/classify.ts` is the safety core and carries the densest tests. Every silent-divergence and OOM-the-host failure mode is a classification bug, and the suite has now caught **seven** real ones — five before the first push, and two more from a single live session:

- `cargo test && cargo fmt` ran the whole line **locally**, because a write hazard masked the build beside it.
- `(cd crates && cargo test)` was classified local, because the build program was only looked for in the first token.
- `2>&1` was read as a file redirection, refusing the most common real shape (`cargo test … 2>&1 | tail -60`).
- `cargo --version` was routed to a sandbox round trip.
- A stale-artifact bug where `tar -x` preserved the local mtime, so cargo judged the sandbox's own artifact newer and **silently skipped the rebuild**.
- `cargo --version && rustc --version` was **refused** as a compound build command. A compound line of pure capability probes now stays local; a compound line containing a real build is still refused.
- A command whose **heredoc body** merely mentioned `cargo` was refused, because the body was scanned as shell syntax. Heredoc bodies are now excluded from classification.

`spike/classify-check.mjs` re-checks every one of these against the emitted `dist/`, so a source/build drift cannot hide them again.

## License

MIT
