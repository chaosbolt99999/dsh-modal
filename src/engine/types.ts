/**
 * Shared engine types. These cross the plugin/proxy process boundary as JSON,
 * so every field is plain and lossless.
 *
 * @module dsh-modal/engine/types
 */

/** Cheap change detector for one source file: size and mtime are enough for
 * cargo's own fingerprinting, which is mtime-based. */
export type FileStamp = readonly [size: number, mtimeMs: number]

/** What the remote mirror contained after the last successful sync. */
export interface SourceManifest {
  readonly files: Record<string, FileStamp>
  readonly syncedAt: number
}

/** One warm sandbox slot. */
export interface LaneState {
  readonly index: number
  sandboxId?: string
  /** `snapshotDirectory` image holding this lane's `target/`. */
  targetImageId?: string
  /** When {@link targetImageId} was last refreshed, so checkpointing amortizes. */
  lastCheckpointAt?: number
  lastUsedAt: number
  /** Cumulative billing facts for the settings card. */
  cpuCoreSeconds?: number
  memGiBSeconds?: number
}

/** Cumulative spend estimate, kept locally and never uploaded. */
export interface SpendState {
  cpuCoreSeconds: number
  memGiBSeconds: number
  estimatedUsd: number
  commands: number
  lastCommandAt: number
}

/** Per-project durable state at `~/.dsh/modal/<key>.json`. */
export interface ProjectState {
  readonly version: 1
  readonly key: string
  readonly workspaceRoot: string
  toolchain: string
  lanes: LaneState[]
  manifest?: SourceManifest
  spend: SpendState
  /** Cache tier that served the most recent command, for provenance. */
  lastCacheTier?: string
}

/** How a lane was satisfied for one command. */
export type LaneAcquisition = 'warm' | 'restored' | 'cold' | 'ephemeral'

/** The resolved routing policy handed to the classifier. */
export interface RoutingSettings {
  readonly mode: 'strict' | 'auto' | 'off'
  readonly onUnroutable: 'deny' | 'local'
  readonly remote: readonly string[]
  readonly forcedLocal: readonly string[]
  readonly remotePathPrefixes: readonly string[]
}

/** Everything the proxy needs to run one command. Serialized into the command line. */
export interface RemoteSettings {
  readonly toolchain: string
  readonly cpu: number
  readonly memoryMiB: number
  /** Wall-clock budget for one remote command. */
  readonly timeoutMs: number
  /** How long a warm lane may sit idle before it is snapshotted and terminated. */
  readonly idleTimeoutMs: number
  readonly lanes: number
  readonly maxLanesPerProject: number
  readonly onLaneExhausted: 'queue' | 'exhausted-ephemeral' | 'fail'
  readonly compute: 'sandbox' | 'function'
  readonly excludes: readonly string[]
  /** How long a proxy waits for a busy lane before giving up. */
  readonly laneWaitMs: number
  readonly aptPackages: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cpuPricePerCoreSecond: number
  readonly memPricePerGiBSecond: number
  readonly monthlyBudgetUsd?: number
  /**
   * Absolute local workspace root for Layer 3 (the `ctx.subprocess` router).
   * Layer 3 has no session context — unlike the bash path, where the executor's
   * workdir supplies it — so the mirror root must be declared when the harness
   * is not launched from the workspace.
   */
  readonly workspaceRoot?: string
}

/** Resolved plugin configuration. */
export interface ResolvedConfig {
  readonly routing: RoutingSettings
  readonly remote: RemoteSettings
}
