/**
 * Toolchain recipes: the per-language facts that turn a toolchain name into a
 * Modal image, a set of cache directories, and an environment.
 *
 * Adding a language means adding one recipe, not touching the engine — decision
 * 5 asked for the generic shape from the start rather than a Rust-only special
 * case that would have to be unpicked later.
 *
 * @module dsh-modal/engine/images
 */

import type { ModalClient } from 'modal'
import type { RemoteSettings } from './types.js'

/** One language/toolchain definition. */
export interface ToolchainRecipe {
  /** Recipe name, as written in config. */
  readonly name: string
  /** Base image reference. */
  readonly imageRef: string
  /** Extra OS packages, installed once at image build time. */
  readonly aptPackages: readonly string[]
  /** Commands run once at image build time (targets, package managers). */
  readonly setupCommands: readonly string[]
  /** Environment for every remote command. */
  readonly env: Readonly<Record<string, string>>
  /** Where the toolchain's download/home cache lives inside the sandbox. */
  readonly cacheHome: string
  /** Subdirectory of {@link cacheHome} snapshotted for the warm cache. */
  readonly cacheSubdirs: readonly string[]
  /**
   * Environment variable naming this toolchain's build-output directory, when
   * it has one. Pointing it at a per-lane path is what keeps parallel lanes
   * from colliding on the same artifacts.
   */
  readonly buildOutputEnv?: string
}

const RUST: ToolchainRecipe = {
  name: 'rust',
  imageRef: 'rust:1.83-bookworm',
  // Mirrors what a Linux CI runner needs for this workspace shape: gpui links
  // against X11/Wayland/keyboard libraries, Loro and sqlite need a C toolchain.
  aptPackages: [
    'build-essential',
    'pkg-config',
    'libssl-dev',
    'libsqlite3-dev',
    'libxkbcommon-dev',
    'libxkbcommon-x11-dev',
    'libwayland-dev',
    'libx11-dev',
    'libxcb1-dev',
    'libfontconfig1-dev',
    'cmake',
    'clang',
    'libclang-dev',
  ],
  setupCommands: ['rustup target add wasm32-unknown-unknown'],
  env: {
    // The single biggest lever on link cost: full debuginfo is 10 GB for one
    // app's test binaries, line-tables-only is 3.6 GB, and backtraces keep file:line.
    CARGO_PROFILE_DEV_DEBUG: 'line-tables-only',
    CARGO_PROFILE_TEST_DEBUG: 'line-tables-only',
    CARGO_TERM_COLOR: 'never',
    CARGO_NET_GIT_FETCH_WITH_CLI: 'true',
  },
  cacheHome: '/cache/cargo',
  cacheSubdirs: ['registry', 'git'],
  buildOutputEnv: 'CARGO_TARGET_DIR',
}

const NODE: ToolchainRecipe = {
  name: 'node',
  imageRef: 'node:22-bookworm',
  aptPackages: ['build-essential', 'pkg-config', 'libssl-dev', 'python3'],
  setupCommands: ['corepack enable'],
  env: { CI: '1', NO_COLOR: '1' },
  cacheHome: '/cache/node',
  cacheSubdirs: ['pnpm-store', 'npm'],
}

const PYTHON: ToolchainRecipe = {
  name: 'python',
  imageRef: 'python:3.12-bookworm',
  aptPackages: ['build-essential', 'pkg-config', 'libssl-dev'],
  setupCommands: [],
  env: { PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1' },
  cacheHome: '/cache/python',
  cacheSubdirs: ['pip'],
}

const GENERIC: ToolchainRecipe = {
  name: 'generic',
  imageRef: 'debian:bookworm-slim',
  aptPackages: ['build-essential', 'ca-certificates', 'git', 'curl'],
  setupCommands: [],
  env: { NO_COLOR: '1' },
  cacheHome: '/cache/generic',
  cacheSubdirs: [],
}

/** Every known recipe, keyed by the name used in config. */
export const RECIPES: Readonly<Record<string, ToolchainRecipe>> = { rust: RUST, node: NODE, python: PYTHON, generic: GENERIC }

/**
 * Look up a recipe, falling back to `generic` rather than failing a command.
 * @param name - the configured toolchain name.
 * @returns the recipe, plus whether the requested name was known.
 */
export function recipeFor(name: string): { recipe: ToolchainRecipe; known: boolean } {
  const found = RECIPES[name]
  return found === undefined ? { recipe: GENERIC, known: false } : { recipe: found, known: true }
}

/** Build (or reuse) the toolchain image for a project. */
export async function buildToolchainImage(
  modal: ModalClient,
  app: Awaited<ReturnType<ModalClient['apps']['fromName']>>,
  recipe: ToolchainRecipe,
  settings: RemoteSettings,
): Promise<{ image: Awaited<ReturnType<ModalClient['images']['fromRegistry']>>; imageId: string }> {
  const extraApt = settings.aptPackages.filter(pkg => !recipe.aptPackages.includes(pkg))
  const apt = [...recipe.aptPackages, ...extraApt]

  let image = modal.images.fromRegistry(recipe.imageRef)
  // `dockerfileCommands` takes Dockerfile INSTRUCTIONS, not bare shell, so each
  // entry must carry its own `RUN `.
  const commands: string[] = []
  if (apt.length > 0) {
    commands.push(
      `RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${apt.join(' ')} && rm -rf /var/lib/apt/lists/*`,
    )
  }
  for (const setup of recipe.setupCommands) commands.push(`RUN ${setup}`)
  if (commands.length > 0) image = image.dockerfileCommands(commands)

  const built = await image.build(app)
  return { image: built, imageId: built.imageId }
}
