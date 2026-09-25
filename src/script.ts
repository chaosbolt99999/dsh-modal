/**
 * The one filesystem reader the classifier uses.
 *
 * It lives here rather than in `classify.ts` so that module stays pure and
 * unit-testable: the classifier asks "what does this script say?", and this
 * answers, including the policy decision about which files may be read at all.
 *
 * The containment rule is the important part. `resolve()` runs synchronously
 * before every shell command, so this must be cheap and must never throw — a
 * refusal is just `undefined`, and the command falls back to running locally.
 *
 * @module dsh-modal/script
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * Largest file worth reading as a script. Anything bigger is not a shell script
 * a build would hide in, and reading it before every command would be waste.
 */
const MAX_SCRIPT_BYTES = 256 * 1024

/**
 * Read a script that lives inside the workspace.
 *
 * Only files contained by `cwd` are readable. That is exactly the set a routed
 * command can act on — the sync mirrors the workspace root and nothing else —
 * so following a script from anywhere else would route a command the sandbox
 * cannot run.
 * @param scriptPath - the path as written in the command.
 * @param cwd - the working directory to resolve a relative path against.
 * @returns the file's text, or undefined when it must not be followed.
 */
export function readWorkspaceScript(scriptPath: string, cwd: string): string | undefined {
  try {
    const root = resolve(cwd)
    const absolute = isAbsolute(scriptPath) ? resolve(scriptPath) : resolve(root, scriptPath)
    // Containment, not a prefix test: `/w-other` must not pass for `/w`.
    if (absolute !== root && !absolute.startsWith(root + sep)) return undefined
    const info = statSync(absolute)
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return undefined
    return readFileSync(absolute, 'utf8')
  } catch {
    // Missing, unreadable, a directory, a broken symlink, or a permission
    // denial. Every one of those means "do not follow it", never "fail".
    return undefined
  }
}
