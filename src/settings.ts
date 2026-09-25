/**
 * The `dsh-modal` settings section.
 *
 * Registering a namespace is what makes the Settings card possible: the card
 * binds to this name, edits land in the user layer, and the hooks re-derive the
 * active policy so a change (say `lanes`) takes effect on the next command
 * without a restart.
 *
 * The whole row config is the namespace schema, so the inherited shell knobs
 * (`maxTimeoutMs` in particular) are editable alongside the Modal settings.
 *
 * @module dsh-modal/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, type PluginConfig } from './config.js'

/** The namespace the Settings card binds to. Lowercase-hyphenated by contract. */
export const SETTINGS_NAMESPACE = 'dsh-modal'

/** Hooks a consumer hands to `installSection`. */
interface SectionHooks<T> {
  setSource(current: () => T): void
  onChange(): void
}

/** The part of the settings service this plugin uses. */
interface SettingsLike {
  installSection(owner: Context, ns: string, schema: unknown, entry: unknown, hooks: SectionHooks<PluginConfig>): void
}

/**
 * Register the settings section when a settings provider is mounted.
 *
 * `ctx.inject` is what waits for the provider: rows mount concurrently, so the
 * service is frequently absent when this plugin constructs. Reading
 * `ctx.get('settings')` synchronously and returning early would skip the card
 * for the rest of the process.
 * @param ctx - the owning context.
 * @param base - the composition entry, used as the base and fallback value.
 * @param onResolved - called whenever the authoritative config changes.
 * @returns whether a section was registered.
 */
export function installSettingsSection(
  ctx: Context,
  base: PluginConfig,
  onResolved: (config: PluginConfig) => void,
): boolean {
  ctx.inject(['settings'], settingsCtx => {
    const settings = settingsCtx.get('settings') as SettingsLike | undefined
    // A harness generation without `installSection` simply has no Settings card;
    // routing still works from the row config.
    if (settings === undefined || typeof settings.installSection !== 'function') return

    let source: (() => PluginConfig) | undefined
    settings.installSection(ctx, SETTINGS_NAMESPACE, Config, base, {
      setSource: current => {
        source = current
        onResolved(current())
      },
      onChange: () => {
        if (source !== undefined) onResolved(source())
      },
    })
  })
  return true
}
