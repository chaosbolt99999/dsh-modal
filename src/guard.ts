/**
 * Enforcement layer: `ctx.tools.guard()`.
 *
 * The shell router is the happy path, but it only runs if the executor is
 * actually consulted. A guard is the harness's monotonic, non-overridable
 * denial — "first monotonic denial from the global then the scope chain's guard
 * layers" — and it fires for EVERY tool call from EVERY package, so it is the
 * right place to enforce the one invariant that must never be violated:
 *
 *   a build command must not silently run on the local machine.
 *
 * Without this, the fallback for a command the classifier declines to route is a
 * multi-minute link on a box that cannot hold it — the exact failure this plugin
 * exists to prevent. With it, the call fails closed with instructions.
 *
 * @module dsh-modal/guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { classify } from './classify.js'
import type { RoutingSettings } from './engine/types.js'

/** Tools whose `command` argument carries shell source we can classify. */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell'])

/**
 * Extract the shell source from a tool call's arguments.
 * @param args - the parsed tool arguments.
 * @returns the command string, when the call carries one.
 */
export function commandOf(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

/**
 * Install the monotonic denial for unroutable build commands.
 * @param ctx - the owning context.
 * @param routing - the resolved routing policy; a non-strict or non-deny policy installs nothing.
 * @returns whether a guard was installed.
 */
export function installGuard(ctx: Context, routing: RoutingSettings): boolean {
  if (routing.mode !== 'strict' || routing.onUnroutable !== 'deny') return false

  ctx.inject(['tools'], toolsCtx => {
    toolsCtx.tools.guard(exec => {
      if (!SHELL_TOOLS.has(exec.name)) return undefined
      const command = commandOf(exec.arguments)
      if (command === undefined) return undefined
      const verdict = classify(command, routing)
      if (verdict.route !== 'deny') return undefined
      return (
        `dsh-modal: refusing to run this locally. ${verdict.reason === 'compound-command' ? 'The command is compound, so it cannot be routed safely' : `The command is ${verdict.reason}`} ` +
        `and it invokes a build tool (${verdict.program ?? 'build'}). Run the build as a single simple command so it can be routed to Modal, ` +
        `or prefix the whole line with DSH_MODAL=force to send it to Modal as-is, or DSH_MODAL=0 to run it locally on purpose.`
      )
    })
  })
  return true
}
