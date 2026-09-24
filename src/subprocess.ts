/**
 * Layer 3: a routing `ctx.subprocess` provider.
 *
 * Layer 1 sees the bash tool's clean shell string. Every OTHER process surface —
 * a PTY-backed shell, a terminal tool, or a future plugin — reaches the machine
 * through `ctx.subprocess` instead, and would otherwise bypass the router
 * entirely. This layer closes that gap by classifying structured argv.
 *
 * It ROUTES rather than FORWARDS. Forwarding everything would break the two
 * consumers that genuinely need the local filesystem — `tool-fs-search`'s
 * glob/grep and any LSP server — and would violate the harness contract that
 * `ctx.fs` and `ctx.subprocess` describe one path namespace. Non-build spawns
 * therefore fall through to the local implementation untouched.
 *
 * @module dsh-modal/subprocess
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { classify } from './classify.js'
import type { PathMapping } from './engine/paths.js'
import { shellJoin, translateArgv } from './engine/paths.js'
import type { RemoteSettings, RoutingSettings } from './engine/types.js'
import { proxyCommand } from './proxy-command.js'

/** Environment marker the proxy sets on itself, so we never re-route our own spawn. */
export const ROUTED_MARKER = 'DSH_MODAL_ROUTED'

/** Raised when a build spawn cannot be safely translated. */
export class UntranslatableBuildError extends Error {
  constructor(reason: string, path: string) {
    super(
      `dsh-modal: refusing to run this build locally and cannot translate it to the sandbox ` +
        `(${reason}: ${path}). Pass a path inside the workspace, or use the bash tool with DSH_MODAL=force.`,
    )
    this.name = 'UntranslatableBuildError'
  }
}

/** Live policy for the router, set by the plugin entry. */
let policy: { routing: RoutingSettings; remote: RemoteSettings } | undefined

/**
 * Publish the active policy to this layer.
 * @param next - resolved routing and remote settings, or undefined to disable.
 */
export function setSubprocessPolicy(next: { routing: RoutingSettings; remote: RemoteSettings } | undefined): void {
  policy = next
}

/** The program a spawn will run, with its directory stripped. */
export function programOfSpec(spec: SubprocessSpawnSpec): string | undefined {
  const argv = spec.argv
  const first = argv?.[0]
  if (typeof first !== 'string' || first === '') return undefined
  const slash = first.lastIndexOf('/')
  return slash === -1 ? first : first.slice(slash + 1)
}

/**
 * Build the proxy spec for one build-shaped spawn.
 * @param spec - the original spawn spec.
 * @param workspaceRoot - absolute local workspace root.
 * @param settings - resolved remote settings.
 * @param mappings - extra absolute prefixes to redirect.
 * @returns the rewritten spawn spec, or the refusal that prevented it.
 */
export function routedSpec(
  spec: SubprocessSpawnSpec,
  workspaceRoot: string,
  settings: RemoteSettings,
  mappings: readonly PathMapping[],
): { readonly ok: true; readonly spec: SubprocessSpawnSpec } | { readonly ok: false; readonly reason: string; readonly path: string } {
  const translated = translateArgv(spec.argv, workspaceRoot, mappings)
  if (!translated.ok) return translated

  const command = shellJoin(translated.argv)
  return {
    ok: true,
    spec: {
      ...spec,
      argv: ['bash', '-c', proxyCommand(command, settings)],
      // The proxy syncs FROM its own cwd, so it must be the local workspace
      // root — not the (possibly deeper) directory the build was aimed at.
      cwd: workspaceRoot,
      env: { ...(spec.env ?? {}), [ROUTED_MARKER]: '1' },
    },
  }
}

/**
 * A subprocess provider that sends build-shaped spawns to Modal and everything
 * else to the local implementation.
 */
export default class SubprocessModalRuntime extends LocalSubprocessRuntime {
  /**
   * Classify one spawn and route it, refuse it, or pass it through locally.
   * @param spec - the spawn specification.
   * @returns the live handle.
   * @throws UntranslatableBuildError when a build spawn cannot be translated.
   */
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const routing = policy?.routing
    const remote = policy?.remote
    if (routing === undefined || remote === undefined || routing.mode === 'off') return super.spawn(spec)
    if ((spec.env ?? {})[ROUTED_MARKER] !== undefined) return super.spawn(spec)

    const program = programOfSpec(spec)
    if (program === undefined || !routing.remote.includes(program)) return super.spawn(spec)

    // A shell wrapper (`bash -c "cargo test"`) cannot be classified from argv
    // alone without re-parsing; Layer 1 already owns that path, so leave it.
    if (program === 'bash' || program === 'sh') return super.spawn(spec)

    // Layer 3 has no session context, so the mirror root must be declared. It
    // defaults to the process cwd, which is only right when the harness is
    // launched from the workspace; `remote.workspaceRoot` overrides it.
    const result = routedSpec(spec, remote.workspaceRoot ?? process.cwd(), remote, [])
    if (!result.ok) throw new UntranslatableBuildError(result.reason, result.path)
    return super.spawn(result.spec)
  }
}
