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
  const codes = routing.remote.map(program => `\`${program}\``).join(' and ')
  const names = routing.remote.join(' or ')
  return [
    '## Where builds run',
    '',
    `Only ${codes} commands are routed. They run on a remote Modal sandbox instead of this machine,`,
    'automatically — write them exactly as you normally would.',
    '',
    '**Every other command runs locally and is completely unchanged.** `bash`, `sh`, `make`, `npm`,',
    '`pnpm`, `node`, `python`, `docker` and everything else execute on this machine and see the real',
    'filesystem, including `/tmp`. Assuming otherwise will make you avoid work you can do normally, or',
    'misdiagnose an ordinary local failure as a sandbox problem.',
    '',
    '- The sandbox holds a synchronized copy of this workspace at the same relative layout, with its own',
    '  persistent build cache. Reads, writes, edits, greps and globs stay local and see the real files.',
    '- Only the WORKSPACE is mirrored. A routed build cannot see `/tmp` or any path outside the workspace,',
    '  so a file a build must read has to live inside the workspace.',
    '- Local-machine constraints do not apply to a routed build: do not assume it will run out of memory,',
    '  and do not restructure a command to be "lighter" for this machine.',
    '- Build output (for example `target/`) exists only in the sandbox, and inspecting it is routed there too.',
    `- A script INSIDE the workspace that invokes ${names} is routed with it, so \`bash build.sh\` builds in the`,
    '  sandbox. A build hidden behind `make`, `just` or `npm run` is NOT routed and would compile on this',
    '  machine — run the build tool directly instead of wrapping it.',
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
