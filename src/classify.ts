/**
 * Pure command classifier: decides whether one shell command runs locally, on
 * Modal, or is refused outright.
 *
 * The rule that keeps read-only inspection local is structural, not a
 * heuristic: `remote` is a POSITIVE allowlist of build programs, and local is
 * the default. `grep`, `wc`, `find`, `ls`, `cat`, `sed -n` and friends are
 * never on the list, so they cannot be redirected by accident.
 *
 * Classification reads three independent facts:
 *   1. PROGram   — which build tool the command invokes.
 *   2. SHAPE     — whether the command is simple enough to route safely at all
 *                  (no compound operators, substitution, or redirection).
 *   3. NAMESPACE — whether the command touches a remote-only path (`target/`),
 *                  which must be inspected where the builds actually happened.
 *
 * Routing is deliberately conservative: an unroutable command whose program is
 * a build tool is REFUSED (never silently run locally), because the fallback
 * would be a multi-minute link on a machine that cannot hold it.
 *
 * @module dsh-modal/classify
 */

/** Where one command should run. */
export type Route = 'local' | 'remote' | 'deny'

/** Routing policy, normally supplied by plugin config. */
export interface RoutingConfig {
  /** `strict` enforces the policy; `auto` allows unroutable builds to run locally; `off` disables routing entirely. */
  readonly mode: 'strict' | 'auto' | 'off'
  /** Build programs that route to Modal when the command shape is safe. */
  readonly remote: readonly string[]
  /** Command prefixes that always run locally because they mutate the tree. */
  readonly forcedLocal: readonly string[]
  /** Path prefixes that exist only in the remote mirror; touching them routes remote. */
  readonly remotePathPrefixes: readonly string[]
  /** What to do with an unroutable command whose program is a build tool. */
  readonly onUnroutable: 'deny' | 'local'
}

/**
 * The default policy: **Rust only**.
 *
 * Rust is the whole reason this plugin exists — a cargo `target/` tree runs to
 * tens of gigabytes and linking it is memory-bound, so moving it off a small
 * host is worth a network round trip. Other toolchains cost a fraction of that,
 * so routing them buys little and only adds ways to be surprised. Adding one
 * later is two lines: a recipe in `engine/images.ts`, and its program here.
 */
export const DEFAULT_ROUTING: RoutingConfig = {
  mode: 'strict',
  remote: ['cargo', 'rustc'],
  forcedLocal: [],
  remotePathPrefixes: ['target/'],
  onUnroutable: 'deny',
}

/** One classification result, with the reason kept for provenance and tests. */
export interface Classification {
  readonly route: Route
  /** Short machine-checkable cause, e.g. `build-program`, `compound-command`. */
  readonly reason: string
  /** The resolved program name, when one could be determined. */
  readonly program?: string
}

/** Programs that only read their input; safe as trailing pipeline stages. */
const SAFE_FILTERS = new Set(['head', 'tail', 'grep', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'cat', 'nl', 'column'])

/**
 * Build-tool subcommands that answer a question instead of building. Checking
 * whether `cargo` exists must not cost a sandbox round trip.
 */
const CHEAP_SUBCOMMANDS = new Set(['locate-project', 'pkgid', 'search', 'info'])

/** Flags that turn a build tool into a capability probe. */
const CHEAP_FLAGS = new Set(['--version', '-V', '-vV', '--help', '-h', '--list'])

/**
 * Shell interpreters whose first non-flag argument names a script FILE.
 *
 * A script's contents are invisible to the shape analysis below, so a build
 * hidden inside one would otherwise run locally and unnoticed — and the guard
 * would not catch it either, because the program is `bash`, not `cargo`.
 */
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh'])

/**
 * The filesystem access the classifier needs in order to look inside a shell
 * script. Supplied by the caller so this module stays pure: it reads no file,
 * resolves no path, and holds no opinion about what "the workspace" is.
 */
export interface ClassifyHooks {
  /** Working directory a relative script path resolves against. */
  readonly cwd: string
  /**
   * Read a script's text, or return undefined when it must not be followed —
   * outside the workspace, missing, not a regular file, or implausibly large.
   * @param scriptPath - the path exactly as written in the command.
   * @param cwd - the working directory to resolve it against.
   */
  readonly readWorkspaceFile: (scriptPath: string, cwd: string) => string | undefined
}

/** Escape a program name for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a script's text invokes a routed build program as a command word.
 *
 * Word-boundary anchored in both directions, so `mycargo` and a
 * `cargo-fmt-wrapper` do not count while `cargo test` and `./cargo` do.
 * @param text - the script's source.
 * @param config - the active routing policy.
 */
function invokesBuildProgram(text: string, config: RoutingConfig): boolean {
  return config.remote.some(program => new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(program)}(?![A-Za-z0-9_.-])`).test(text))
}

/**
 * The script path when a command is `<shell> <script> [args...]`.
 *
 * `bash -c "…"` runs inline source rather than a file, so it yields undefined —
 * that shape is already handled as unroutable.
 * @param main - the reduced pipeline stage.
 * @param program - its program name.
 */
function shellScriptPath(main: readonly Token[], program: string): string | undefined {
  if (!SHELL_INTERPRETERS.has(program)) return undefined
  const first = main.filter(t => t.kind === 'word')[1]
  if (first === undefined) return undefined
  return first.value.startsWith('-') ? undefined : first.value
}

/**
 * Write hazards. Every one of these mutates the working tree, so they are
 * forced local regardless of configuration: a remote write would land in the
 * mirror and silently diverge from the local tree.
 */
const HAZARD_PATTERNS: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /\bcargo\s+fmt\b(?![\s\S]*--check)/, why: 'cargo-fmt-writes' },
  { re: /\bcargo\s+fix\b/, why: 'cargo-fix-writes' },
  { re: /--fix\b/, why: 'fix-flag-writes' },
  { re: /\bcargo\s+(?:add|remove|new|init|install|publish|update|vendor)\b/, why: 'cargo-mutates-manifest' },
  { re: /\binsta\s+(?:review|accept)\b/, why: 'insta-accepts-snapshots' },
]

type Token = { readonly kind: 'word' | 'op'; readonly value: string }

interface Scan {
  readonly tokens: readonly Token[]
  /** A substitution or unbalanced quote makes the command unclassifiable. */
  readonly unsafe: boolean
}

const OPERATOR_CHARS = new Set([';', '|', '&', '>', '<', '(', ')'])

/**
 * Split a command into words and operators, honouring quoting.
 *
 * This is intentionally a scanner rather than a full shell parser: it only has
 * to be accurate about whether a command is SIMPLE, and being conservative
 * (calling something unsafe when it is not) costs one local run rather than a
 * wrong remote mirror write.
 * @param command - the raw shell source.
 * @returns the token list and whether the command is structurally unsafe.
 */
export function scan(command: string): Scan {
  const tokens: Token[] = []
  let word = ''
  let i = 0
  let unsafe = false
  let quote: '"' | "'" | undefined

  const flush = (): void => {
    if (word !== '') {
      tokens.push({ kind: 'word', value: word })
      word = ''
    }
  }
  const pushOp = (value: string): void => {
    flush()
    tokens.push({ kind: 'op', value })
  }

  while (i < command.length) {
    const ch = command[i] as string
    if (quote === "'") {
      if (ch === "'") quote = undefined
      else word += ch
      i += 1
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined
      // Command substitution is live even inside double quotes.
      else if (ch === '`' || (ch === '$' && command[i + 1] === '(')) unsafe = true
      else word += ch
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '\\') {
      word += command[i + 1] ?? ''
      i += 2
      continue
    }
    if (ch === '`' || (ch === '$' && command[i + 1] === '(')) {
      unsafe = true
      i += 1
      continue
    }
    if (ch === '$' && command[i + 1] === '{') {
      // Parameter expansion is fine; brace grouping is not a shell operator here.
      word += ch
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      i += 1
      continue
    }
    if (ch === '\n') {
      pushOp(';')
      i += 1
      continue
    }
    // File-descriptor duplication (`2>&1`, `>&2`, `<&0`) only rewires a stream
    // within the command; it opens no file, so it must not disqualify an
    // otherwise simple build command. Agents write `2>&1 | tail` constantly.
    if ((ch === '>' || ch === '<') && command[i + 1] === '&') {
      if (/^\d*$/.test(word)) word = ''
      else flush()
      i += 2
      if (/^\d$/.test(command[i] ?? '')) i += 1
      continue
    }
    if (OPERATOR_CHARS.has(ch)) {
      // Fold the two-character operators first.
      const two = command.slice(i, i + 2)
      if (two === '&&' || two === '||' || two === '>>') {
        pushOp(two)
        i += 2
        continue
      }
      pushOp(ch)
      i += 1
      continue
    }
    word += ch
    i += 1
  }
  flush()
  if (quote !== undefined) unsafe = true
  return { tokens, unsafe }
}

/** Strip a leading directory so `/usr/bin/cargo` classifies as `cargo`. */
function programOf(word: string): string {
  const slash = word.lastIndexOf('/')
  return slash === -1 ? word : word.slice(slash + 1)
}

/**
 * The part of a command that is shell syntax, excluding heredoc bodies.
 *
 * A heredoc body is DATA. Scanning it as syntax produces false positives in
 * both directions: `cat > notes.md <<'EOF' … cargo test … EOF` looks like a
 * compound build command, and a body mentioning a build tool is enough to have
 * the whole call refused.
 * @param command - the raw shell source.
 * @returns the text before the first heredoc operator.
 */
export function beforeHeredoc(command: string): string {
  const match = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.exec(command)
  return match === null ? command : command.slice(0, match.index)
}

/** One build-tool invocation found inside a command that could not be reduced. */
interface BuildInvocation {
  readonly program: string
  /** Words following the program, used to tell a probe from a build. */
  readonly argv: readonly string[]
}

/**
 * Whether one build-tool invocation only asks a question.
 *
 * A run of switches containing a version or help switch counts, so `cargo
 * --version --verbose` is a probe rather than a build.
 * @param argv - the words following the program.
 */
function isProbeArgs(argv: readonly string[]): boolean {
  if (argv.length === 0) return true
  if (CHEAP_SUBCOMMANDS.has(argv[0] as string)) return true
  const flags = argv.filter(word => word.startsWith('-'))
  return flags.length === argv.length && flags.some(flag => CHEAP_FLAGS.has(flag))
}

interface Structure {
  /** The pipeline stage that carries the real work, when the shape is simple. */
  readonly main: readonly Token[] | undefined
  /** Why the shape could not be reduced, when it could not. */
  readonly reason?: string
  /** Build-tool invocations seen anywhere in an unroutable command. */
  readonly invocations?: readonly BuildInvocation[]
}

/**
 * Reduce a token list to its main command, or explain why it cannot be.
 * @param tokens - output of {@link scan}.
 * @param config - the active routing policy.
 * @returns the main pipeline stage, or a reason it is unroutable.
 */
function reduce(tokens: readonly Token[], config: RoutingConfig): Structure {
  // A build tool is worth refusing wherever it appears — a later statement, a
  // pipeline stage, or inside a subshell all count. Looking only at the first
  // token would let `(cd x && cargo test)` masquerade as ordinary shell work.
  //
  // Splitting on statement separators AND pipeline bars is what lets each
  // invocation be judged on its own arguments, so a compound line of pure
  // capability probes (`cargo --version && rustc --version`) is not mistaken
  // for a build.
  const collect = (all: readonly Token[]): BuildInvocation[] => {
    const parts: Token[][] = [[]]
    for (const t of all) {
      if (t.kind === 'op' && (t.value === ';' || t.value === '&&' || t.value === '||' || t.value === '&' || t.value === '|')) {
        parts.push([])
        continue
      }
      ;(parts[parts.length - 1] as Token[]).push(t)
    }
    const out: BuildInvocation[] = []
    for (const part of parts) {
      const head = part[0]
      if (head === undefined || head.kind !== 'word') continue
      const program = programOf(head.value)
      if (!config.remote.includes(program)) continue
      out.push({ program, argv: part.slice(1).filter(t => t.kind === 'word').map(t => t.value) })
    }
    return out
  }
  const found = collect(tokens)
  const withFound = found.length > 0 ? { invocations: found } : {}

  // Split on every statement separator; more than one statement is compound.
  const segments: Token[][] = [[]]
  for (const t of tokens) {
    if (t.kind === 'op' && (t.value === ';' || t.value === '&&' || t.value === '||' || t.value === '&')) segments.push([])
    else (segments[segments.length - 1] as Token[]).push(t)
  }
  const live = segments.filter(s => s.length > 0)
  if (live.length > 1) {
    return { main: undefined, reason: 'compound-command', ...withFound }
  }
  const only = live[0]
  if (only === undefined) return { main: undefined, reason: 'empty-command' }

  if (only.some(t => t.kind === 'op' && (t.value === '>' || t.value === '<' || t.value === '>>' || t.value === '(' || t.value === ')'))) {
    return { main: undefined, reason: 'redirection-or-subshell', ...withFound }
  }

  // A pipeline is routable only when every stage after the first is a read-only filter.
  const stages: Token[][] = [[]]
  for (const t of only) {
    if (t.kind === 'op' && t.value === '|') stages.push([])
    else (stages[stages.length - 1] as Token[]).push(t)
  }
  const first = stages[0]
  if (first === undefined || first.length === 0) return { main: undefined, reason: 'empty-command' }
  for (const stage of stages.slice(1)) {
    const head = stage[0]
    if (head === undefined || head.kind !== 'word' || !SAFE_FILTERS.has(programOf(head.value))) {
      return { main: undefined, reason: 'unsafe-pipeline-stage', ...withFound }
    }
  }
  return { main: first }
}

/**
 * Classify one command.
 * @param command - the raw shell source the model asked to run.
 * @param config - the active routing policy.
 * @param hooks - optional filesystem access, enabling a look inside workspace shell scripts.
 * @returns where it should run, and why.
 */
export function classify(command: string, config: RoutingConfig = DEFAULT_ROUTING, hooks?: ClassifyHooks): Classification {
  const trimmed = command.trim()
  if (trimmed === '') return { route: 'local', reason: 'empty-command' }

  // The documented escape hatches: an explicit env prefix always wins.
  if (/^(?:env\s+)?DSH_MODAL=(?:0|off|false)\b/.test(trimmed)) return { route: 'local', reason: 'escape-hatch' }

  // `force` sends an otherwise unroutable line (compound, redirected, subshell)
  // to the sandbox as-is. Hazards below still apply: mutation always runs locally.
  const forced = /^(?:env\s+)?DSH_MODAL=force\b/.test(trimmed)
  const effective = forced ? trimmed.replace(/^(?:env\s+)?DSH_MODAL=force\s*/, '') : trimmed

  if (config.mode === 'off') return { route: 'local', reason: 'routing-off' }

  const { tokens, unsafe } = scan(beforeHeredoc(effective))
  const structure = reduce(tokens, config)

  if (forced) {
    // Hazards are judged on the whole line here: the caller asked for the exact
    // text to run remotely, so there is no reduced command to inspect.
    for (const hazard of HAZARD_PATTERNS) {
      if (hazard.re.test(effective)) return { route: 'local', reason: hazard.why }
    }
    const seen = tokens.map(t => (t.kind === 'word' ? programOf(t.value) : '')).find(p => config.remote.includes(p))
    return seen !== undefined
      ? { route: 'remote', reason: 'forced-remote', program: seen }
      : { route: 'local', reason: 'forced-remote-without-build-program' }
  }

  if (unsafe || structure.main === undefined) {
    const reason = unsafe ? 'unsafe-shell-syntax' : (structure.reason ?? 'unroutable')
    const found = structure.invocations ?? []
    // Only a command that actually builds is worth refusing. A compound line of
    // capability probes is ordinary inspection and stays local: denying
    // `cargo --version && rustc --version` would be pure friction with no
    // safety value, since neither compiles anything.
    const real = found.filter(invocation => !isProbeArgs(invocation.argv))
    if (real.length === 0) {
      return found.length > 0
        ? { route: 'local', reason: 'capability-probe-in-compound', program: (found[0] as BuildInvocation).program }
        : { route: 'local', reason }
    }
    const program = (real[0] as BuildInvocation).program
    return config.onUnroutable === 'deny'
      ? { route: 'deny', reason, program }
      : { route: 'local', reason: `${reason}-fell-back`, program }
  }

  const main = structure.main
  if (main === undefined) return { route: 'local', reason: 'unroutable' }
  const mainText = main.map(t => t.value).join(' ')

  // Hazards are judged on the REDUCED command, never the raw string. Checking
  // the raw text first would let a hazard anywhere in a compound command mask
  // the build beside it — `cargo test && cargo fmt` would then run locally,
  // compiling the very thing this plugin exists to move off the machine.
  for (const hazard of HAZARD_PATTERNS) {
    if (hazard.re.test(mainText)) return { route: 'local', reason: hazard.why }
  }
  for (const prefix of config.forcedLocal) {
    if (prefix !== '' && mainText.startsWith(prefix)) return { route: 'local', reason: 'configured-forced-local' }
  }

  const head = main[0] as Token
  const program = programOf(head.value)

  if (config.remote.includes(program)) {
    // A probe is not a build. `cargo --version`, `cargo --help`, `cargo` alone
    // and the cheap query subcommands all answer locally.
    const args = main.filter(t => t.kind === 'word').slice(1).map(t => t.value)
    if (isProbeArgs(args)) {
      const subcommand = args[0]
      return {
        route: 'local',
        reason: subcommand !== undefined && CHEAP_SUBCOMMANDS.has(subcommand) ? 'cheap-subcommand' : 'capability-probe',
        program,
      }
    }
    return { route: 'remote', reason: 'build-program', program }
  }

  // A build hidden inside a shell script is still a build. The shape analysis
  // cannot see into the file, so without this `bash build.sh` compiles locally
  // and unnoticed — and the guard cannot catch it either, because the program
  // is `bash`, not `cargo`.
  //
  // Only a script INSIDE the workspace is followed. A routed command runs
  // against the mirrored workspace, so a script from anywhere else could not be
  // run remotely even if its contents were a build; following it would turn a
  // working local command into a remote failure.
  if (hooks !== undefined) {
    const scriptPath = shellScriptPath(main, program)
    if (scriptPath !== undefined) {
      const script = hooks.readWorkspaceFile(scriptPath, hooks.cwd)
      if (script !== undefined) {
        // A script that rewrites the tree must stay local, exactly as the same
        // command typed directly would: a remote write lands in the mirror and
        // silently diverges.
        if (HAZARD_PATTERNS.some(hazard => hazard.re.test(script))) {
          return { route: 'local', reason: 'script-contains-write-hazard', program }
        }
        if (invokesBuildProgram(script, config)) {
          return { route: 'remote', reason: 'workspace-script-invokes-build', program }
        }
      }
    }
  }

  // Namespace rule: `target/` only exists in the mirror, so inspecting it must
  // happen where the build ran, even though the program itself is read-only.
  if (config.remotePathPrefixes.some(prefix => main.some(t => t.kind === 'word' && t.value.includes(prefix)))) {
    return { route: 'remote', reason: 'remote-path-namespace', program }
  }

  return { route: 'local', reason: 'not-a-build-program', program }
}
