/**
 * Path translation between the local workspace and the remote mirror.
 *
 * Layer 3 intercepts structured argv, so it can translate precisely — and,
 * crucially, refuse when it cannot. A silently mistranslated path is far worse
 * than an error: it would compile the wrong tree or write to an unexpected
 * location. Everything outside the workspace root and the configured mappings
 * therefore fails closed.
 *
 * @module dsh-modal/engine/paths
 */

import { REMOTE_SOURCE_ROOT } from './sync.js'

/** One absolute local prefix to redirect, and where it lands remotely. */
export interface PathMapping {
  readonly from: string
  readonly to: string
}

/** The outcome of translating one argument. */
export type Translation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string; readonly path: string }

/** Normalize away a trailing slash so prefix tests are predictable. */
function normalize(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

/**
 * Translate one argv entry or working directory.
 *
 * Relative paths need no work: they resolve under the already-translated cwd.
 * `-` (stdin) and empty strings pass through untouched.
 * @param value - the argv entry or cwd.
 * @param workspaceRoot - absolute local workspace root.
 * @param mappings - additional absolute prefixes to redirect.
 * @returns the translated value, or a refusal naming the offending path.
 */
export function translatePath(value: string, workspaceRoot: string, mappings: readonly PathMapping[] = []): Translation {
  if (value === '' || value === '-' || !isAbsolute(value)) return { ok: true, value }

  const root = normalize(workspaceRoot)
  if (value === root) return { ok: true, value: REMOTE_SOURCE_ROOT }
  if (value.startsWith(`${root}/`)) return { ok: true, value: `${REMOTE_SOURCE_ROOT}${value.slice(root.length)}` }

  for (const mapping of mappings) {
    const from = normalize(mapping.from)
    if (value === from) return { ok: true, value: mapping.to }
    if (value.startsWith(`${from}/`)) return { ok: true, value: `${mapping.to}${value.slice(from.length)}` }
  }

  // Absolute paths outside every mapping cannot be trusted to mean the same
  // thing in the sandbox. `-` style flags are not paths and were handled above.
  return { ok: false, reason: 'path-outside-workspace', path: value }
}

/**
 * Translate a whole argv, allowing known-benign system paths through.
 *
 * Flags and `/usr`, `/bin`, `/lib` style system paths are left alone: the
 * toolchain image provides its own copies, and refusing them would break
 * ordinary invocations such as `--manifest-path /usr/...` (rare) or absolute
 * tool references (common).
 * @param argv - the program and its arguments.
 * @param workspaceRoot - absolute local workspace root.
 * @param mappings - additional absolute prefixes to redirect.
 * @returns the translated argv, or a refusal.
 */
export function translateArgv(
  argv: readonly string[],
  workspaceRoot: string,
  mappings: readonly PathMapping[] = [],
): { readonly ok: true; readonly argv: string[] } | { readonly ok: false; readonly reason: string; readonly path: string } {
  const out: string[] = []
  for (const arg of argv) {
    // `--flag=/abs/path` carries its path after the equals sign.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    if (eq !== -1) {
      const head = arg.slice(0, eq + 1)
      const tail = arg.slice(eq + 1)
      const translated = translatePath(tail, workspaceRoot, mappings)
      if (!translated.ok) return translated
      out.push(`${head}${translated.value}`)
      continue
    }
    const translated = translatePath(arg, workspaceRoot, mappings)
    if (!translated.ok) {
      // A bare absolute path that is clearly a system location is not ours to
      // translate; the image provides it.
      if (/^\/(usr|bin|sbin|lib|lib64|etc|proc|sys|dev|opt)(\/|$)/.test(arg)) {
        out.push(arg)
        continue
      }
      return translated
    }
    out.push(translated.value)
  }
  return { ok: true, argv: out }
}

/** Quote one word for POSIX shell inclusion. */
export function shellQuote(word: string): string {
  if (word === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word
  return `'${word.split("'").join("'\\''")}'`
}

/**
 * Render an argv as a single shell command line.
 * @param argv - the words to join.
 * @returns a POSIX-safe command string.
 */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}
