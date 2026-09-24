/**
 * Construction of the proxy command line.
 *
 * Lives in its own module because both the shell router (Layer 1) and the
 * subprocess router (Layer 3) emit it, and importing either entry point from the
 * other would create a cycle.
 *
 * @module dsh-modal/proxy-command
 */

import type { RemoteSettings } from './engine/types.js'

/** The proxy entry point, resolved relative to this module. */
export const PROXY_PATH = new URL('../bin/exec.js', import.meta.url)

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

/**
 * Build the proxy invocation for one command.
 *
 * The command travels base64-encoded rather than quoted: it is a shell string
 * being nested inside another shell string, and encoding removes that entire
 * class of escaping bug. The settings travel the same way so the proxy needs no
 * config of its own.
 * @param command - the original shell source.
 * @param settings - resolved remote settings for this command.
 * @param extraArgs - additional proxy flags, e.g. `--lane-affinity`.
 * @returns a single simple command line that invokes the proxy.
 */
export function proxyCommand(command: string, settings: RemoteSettings, extraArgs: readonly string[] = []): string {
  const parts = [
    'node',
    `'${PROXY_PATH.pathname}'`,
    '--command-b64',
    `'${encode(command)}'`,
    '--settings-b64',
    `'${encode(JSON.stringify(settings))}'`,
    ...extraArgs,
  ]
  return parts.join(' ')
}
