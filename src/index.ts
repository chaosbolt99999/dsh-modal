/**
 * dsh-modal — route compile/test work to a Modal sandbox while keeping
 * read-only inspection local.
 *
 * Three layers, each closing a different hole:
 *
 *   Layer 1 (`ctx.shell`)       this executor's `resolve()`, which sees the bash
 *                               tool's clean shell string and diverts build work.
 *   Layer 2 (`ctx.tools.guard`) a monotonic, non-overridable denial so an
 *                               unroutable build fails closed instead of silently
 *                               compiling on the local machine.
 *   Layer 3 (`ctx.subprocess`)  the separate `dsh-modal/subprocess` row, which
 *                               covers process surfaces that never touch
 *                               `ctx.shell`.
 *
 * `dsh-tool-bash` calls `ctx.shell.run(ctx.shell.resolve(request))` — and the
 * same pair for background jobs — so rewriting the resolved spec in Layer 1
 * covers 100% of bash tool commands, foreground and background, with no change
 * to `run`/`start` and therefore no loss of the inherited sandbox, deadline,
 * output-cap, spill and process-handling behaviour.
 *
 * @module dsh-modal
 */

import type { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { Config as ConfigSchema, resolveConfig, type PluginConfig } from './config.js'
import { classify, type Classification } from './classify.js'
import { installGuard } from './guard.js'
import { installPrompt } from './prompt.js'
import { proxyCommand } from './proxy-command.js'
import { installSettingsSection } from './settings.js'
import { setSubprocessPolicy } from './subprocess.js'
import type { RemoteSettings, RoutingSettings } from './engine/types.js'

export const name = 'dsh-modal'

export { Config } from './config.js'
export { classify, scan, DEFAULT_ROUTING } from './classify.js'
export type { Classification, Route, RoutingConfig } from './classify.js'

/** The policy of the mounted instance. One shell executor exists per context, so this is unambiguous. */
let active: { routing: RoutingSettings; remote: RemoteSettings } | undefined

/** Read the active policy, if the plugin is mounted. */
export function activePolicy(): { routing: RoutingSettings; remote: RemoteSettings } | undefined {
  return active
}

/** Raised when policy refuses to run a build command locally. */
export class UnroutableBuildError extends Error {
  constructor(readonly classification: Classification) {
    super(
      `dsh-modal refused to run a build command locally (${classification.reason}` +
        `${classification.program !== undefined ? `: ${classification.program}` : ''}). ` +
        'Split it into a single simple command, prefix it with DSH_MODAL=force to send it to the sandbox as-is, ' +
        'or prefix it with DSH_MODAL=0 to run it locally on purpose.',
    )
    this.name = 'UnroutableBuildError'
  }
}

/**
 * Routes build commands to Modal; runs everything else locally through the
 * inherited sandboxing executor.
 */
export default class ModalBashExecutor extends SandboxBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']
  static override Config = ConfigSchema

  constructor(ctx: Context, config: PluginConfig) {
    super(ctx, config)
    const resolved = resolveConfig(config)
    active = resolved

    installGuard(ctx, resolved.routing)
    installPrompt(ctx, resolved.routing, resolved.remote)
    // A settings edit re-derives the policy, so it applies to the next command
    // rather than needing a restart.
    installSettingsSection(ctx, config, next => {
      const updated = resolveConfig(next)
      active = updated
      setSubprocessPolicy(updated)
    })
    // Layer 3 reads its policy from here; it is mounted by its own row so that
    // enabling it is an explicit composition decision.
    setSubprocessPolicy(resolved)

    // Reversible: unloading the plugin clears the policy the other layers read.
    ctx.effect(() => () => {
      if (active === resolved) active = undefined
      setSubprocessPolicy(undefined)
    })
  }

  /**
   * Classify the resolved command and divert it when it is build work.
   * @param request - the caller's request; defaults and caps come from the parent.
   * @returns the spec the inherited `run`/`start` will execute.
   * @throws UnroutableBuildError when policy refuses an unroutable build command.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const spec = super.resolve(request)
    const policy = active
    if (policy === undefined) return spec

    const verdict = classify(spec.command, policy.routing)
    if (verdict.route === 'deny') throw new UnroutableBuildError(verdict)
    if (verdict.route === 'local') return spec

    return {
      ...spec,
      command: proxyCommand(spec.command, policy.remote),
      // A routed build is long by nature, while the inherited deadline is sized
      // for local commands (two minutes by default). Raise it to the remote
      // budget so a real test suite is not killed part-way through.
      timeoutMs: Math.max(spec.timeoutMs, policy.remote.timeoutMs),
    }
  }
}
