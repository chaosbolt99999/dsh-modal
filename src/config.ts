/**
 * Plugin configuration: schemastery schema plus the resolver that turns a
 * partial row config into the fully defaulted {@link ResolvedConfig}.
 *
 * Defaults live here as plain constants and are applied by {@link resolveConfig}
 * rather than by nested schema `.default()` calls. That keeps them readable,
 * unit-testable, and shared with the proxy, and it makes a bad enum value fail
 * with an explicit message instead of a schema trace.
 *
 * @module dsh-modal/config
 */

import z from '@deepseek-ai/schemastery'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { DEFAULT_ROUTING as CLASSIFIER_DEFAULTS } from './classify.js'
import type { RemoteSettings, RoutingSettings } from './engine/types.js'

/** The shell executor's own knobs, inherited verbatim so the row stays a drop-in. */
export interface ShellConfig {
  cwd?: string
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxSpillBytes?: number
  graceMs?: number
}

/** Row config: the inherited shell knobs plus this plugin's sections. */
export interface PluginConfig extends ShellConfig {
  routing?: Partial<RoutingSettings>
  remote?: Partial<RemoteSettings>
}

/**
 * Routing defaults.
 *
 * Re-exported from the classifier so the policy that is *enforced* and the
 * policy that is *defaulted* can never drift apart — they were two copies of
 * one list before, which is exactly how a program ends up routed in one place
 * and ignored in another.
 */
export const DEFAULT_ROUTING: RoutingSettings = {
  mode: CLASSIFIER_DEFAULTS.mode,
  onUnroutable: CLASSIFIER_DEFAULTS.onUnroutable,
  remote: CLASSIFIER_DEFAULTS.remote,
  forcedLocal: CLASSIFIER_DEFAULTS.forcedLocal,
  remotePathPrefixes: CLASSIFIER_DEFAULTS.remotePathPrefixes,
}

/**
 * Remote defaults.
 *
 * `cpu: 2` rather than 8 is deliberate: Modal bills `max(request, actual)` and
 * a sandbox bursts above its request, so a low request makes idle time ~4x
 * cheaper while real builds still get the cores. Memory is NOT safe to
 * under-request, so it stays near the observed peak.
 */
export const DEFAULT_REMOTE: RemoteSettings = {
  toolchain: 'rust',
  cpu: 2,
  memoryMiB: 24_576,
  timeoutMs: 90 * 60 * 1000,
  idleTimeoutMs: 120_000,
  lanes: 2,
  maxLanesPerProject: 3,
  onLaneExhausted: 'queue',
  compute: 'sandbox',
  excludes: ['target', '.git', 'node_modules', '.dsh-modal', 'dist', '.venv', '__pycache__'],
  laneWaitMs: 30 * 60 * 1000,
  aptPackages: [],
  env: {},
  // Modal list pricing, USD per second.
  cpuPricePerCoreSecond: 0.00003942,
  memPricePerGiBSecond: 0.00000667,
}

/** The row's config schema: the parent's fields, merged without duplicating defaults. */
export const Config = z.object({
  ...(LocalBashExecutor.Config as unknown as { dict: Record<string, unknown> }).dict,
  routing: z.object({
    mode: z.string().default(DEFAULT_ROUTING.mode),
    onUnroutable: z.string().default(DEFAULT_ROUTING.onUnroutable),
    remote: z.array(z.string()).default([...DEFAULT_ROUTING.remote]),
    forcedLocal: z.array(z.string()).default([]),
    remotePathPrefixes: z.array(z.string()).default([...DEFAULT_ROUTING.remotePathPrefixes]),
  }),
  remote: z.object({
    toolchain: z.string().default(DEFAULT_REMOTE.toolchain),
    cpu: z.number().default(DEFAULT_REMOTE.cpu),
    memoryMiB: z.number().default(DEFAULT_REMOTE.memoryMiB),
    timeoutMs: z.number().default(DEFAULT_REMOTE.timeoutMs),
    idleTimeoutMs: z.number().default(DEFAULT_REMOTE.idleTimeoutMs),
    lanes: z.number().default(DEFAULT_REMOTE.lanes),
    maxLanesPerProject: z.number().default(DEFAULT_REMOTE.maxLanesPerProject),
    onLaneExhausted: z.string().default(DEFAULT_REMOTE.onLaneExhausted),
    compute: z.string().default(DEFAULT_REMOTE.compute),
    excludes: z.array(z.string()).default([...DEFAULT_REMOTE.excludes]),
    laneWaitMs: z.number().default(DEFAULT_REMOTE.laneWaitMs),
    aptPackages: z.array(z.string()).default([]),
    env: z.dict(z.string()).default({}),
    workspaceRoot: z.string(),
    monthlyBudgetUsd: z.number(),
  }),
}) as unknown as z<PluginConfig>

function pickEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, field: string): T {
  if (value === undefined) return fallback
  if (!allowed.includes(value as T)) {
    throw new Error(`dsh-modal: ${field} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(value)})`)
  }
  return value as T
}

/**
 * Apply defaults and validate enum fields.
 * @param config - the row config, possibly partial.
 * @returns the fully resolved configuration.
 * @throws Error when an enum field holds an unsupported value.
 */
export function resolveConfig(config: PluginConfig = {}): { routing: RoutingSettings; remote: RemoteSettings } {
  const r = config.routing ?? {}
  const m = config.remote ?? {}

  const routing: RoutingSettings = {
    mode: pickEnum(r.mode, ['strict', 'auto', 'off'] as const, DEFAULT_ROUTING.mode, 'routing.mode'),
    onUnroutable: pickEnum(r.onUnroutable, ['deny', 'local'] as const, DEFAULT_ROUTING.onUnroutable, 'routing.onUnroutable'),
    remote: r.remote ?? DEFAULT_ROUTING.remote,
    forcedLocal: r.forcedLocal ?? DEFAULT_ROUTING.forcedLocal,
    remotePathPrefixes: r.remotePathPrefixes ?? DEFAULT_ROUTING.remotePathPrefixes,
  }

  const lanes = Math.max(1, Math.min(8, m.lanes ?? DEFAULT_REMOTE.lanes))
  const remote: RemoteSettings = {
    toolchain: m.toolchain ?? DEFAULT_REMOTE.toolchain,
    cpu: m.cpu ?? DEFAULT_REMOTE.cpu,
    memoryMiB: m.memoryMiB ?? DEFAULT_REMOTE.memoryMiB,
    timeoutMs: m.timeoutMs ?? DEFAULT_REMOTE.timeoutMs,
    idleTimeoutMs: m.idleTimeoutMs ?? DEFAULT_REMOTE.idleTimeoutMs,
    lanes,
    // The cap can never be below the lane count, or a lane could never be built.
    maxLanesPerProject: Math.max(lanes, m.maxLanesPerProject ?? DEFAULT_REMOTE.maxLanesPerProject),
    onLaneExhausted: pickEnum(
      m.onLaneExhausted,
      ['queue', 'exhausted-ephemeral', 'fail'] as const,
      DEFAULT_REMOTE.onLaneExhausted,
      'remote.onLaneExhausted',
    ),
    compute: pickEnum(m.compute, ['sandbox', 'function'] as const, DEFAULT_REMOTE.compute, 'remote.compute'),
    excludes: m.excludes ?? DEFAULT_REMOTE.excludes,
    laneWaitMs: m.laneWaitMs ?? DEFAULT_REMOTE.laneWaitMs,
    aptPackages: m.aptPackages ?? DEFAULT_REMOTE.aptPackages,
    env: m.env ?? DEFAULT_REMOTE.env,
    cpuPricePerCoreSecond: m.cpuPricePerCoreSecond ?? DEFAULT_REMOTE.cpuPricePerCoreSecond,
    memPricePerGiBSecond: m.memPricePerGiBSecond ?? DEFAULT_REMOTE.memPricePerGiBSecond,
    ...(m.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: m.monthlyBudgetUsd } : {}),
    ...(m.workspaceRoot !== undefined ? { workspaceRoot: m.workspaceRoot } : {}),
  }

  return { routing, remote }
}
