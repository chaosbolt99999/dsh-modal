/**
 * The model-facing prompt section.
 *
 * Routing is transparent, which is good for the model's habits and bad for its
 * mental model: an agent that believes it is compiling locally will reason
 * wrongly about its own machine (memory, wall-clock, where `target/` lives).
 * One short section fixes that, and tells the model how to override the router
 * when it has a reason to.
 *
 * @module dsh-modal/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { RemoteSettings, RoutingSettings } from './engine/types.js'

/**
 * Sort order for this section. High enough to land near the end of the prompt,
 * away from the repository-owned allocation.
 */
const SECTION_ORDER = 900

/** Render the section body for the active policy. */
export function promptText(routing: RoutingSettings, remote: RemoteSettings): string {
  if (routing.mode === 'off') return ''
  const programs = routing.remote.join(', ')
  return [
    '## Where builds run',
    '',
    `Compile, test, lint and doctest commands (${programs}) run on a remote Modal sandbox, not on this machine,`,
    'and are routed automatically — write them exactly as you normally would.',
    '',
    '- The sandbox holds a synchronized copy of this workspace at the same relative layout, with its own',
    '  persistent build cache. Reads, writes, edits, greps and globs stay local and see the real files.',
    '- Local-machine constraints do not apply to a build: do not assume it will run out of memory, and do not',
    '  restructure a command to be "lighter" for this machine.',
    '- Build output (for example `target/`) exists only in the sandbox. Inspecting it is routed there too.',
    '- Commands that only read the tree (`grep`, `wc`, `find`, `git log`, `cat`, `ls`) stay local and are fast.',
    '- A build command that cannot be routed safely (a compound line, a redirect, a subshell) is refused rather',
    '  than run locally. Split it into single commands.',
    `- Overrides: \`DSH_MODAL=0 <command>\` runs locally on purpose; \`DSH_MODAL=force <command>\` forces an`,
    '  unroutable command to Modal as-is. Commands that write to the tree (`cargo fmt`, `cargo fix --fix`,',
    '  `cargo add`) always run locally.',
    '',
    `Sandbox: ${remote.cpu} CPU / ${Math.round(remote.memoryMiB / 1024)} GiB, toolchain \`${remote.toolchain}\`, ${remote.lanes} lane(s).`,
  ].join('\n')
}

/**
 * Register the prompt section.
 * @param ctx - the owning context.
 * @param routing - the resolved routing policy.
 * @param remote - the resolved remote settings.
 * @returns whether a section was registered.
 */
export function installPrompt(ctx: Context, routing: RoutingSettings, remote: RemoteSettings): boolean {
  const text = promptText(routing, remote)
  if (text === '') return false
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.systemPrompt.section({ name: 'dsh-modal', order: SECTION_ORDER, text })
  })
  return true
}
