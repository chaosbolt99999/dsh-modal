import * as React from 'react'

/**
 * Browser half of dsh-modal: a `settings.plugin.item` card keyed by the host
 * settings namespace, so the routing policy, sandbox size, lane count and cache
 * policy are editable in Settings → Plugins.
 *
 * Nested sections are written whole (`set('remote', {...})`) rather than by
 * dotted path, because `Scope.set` takes one top-level field name and a partial
 * nested patch would silently drop the sibling keys.
 */

/** Must equal the host-side settings namespace. */
const SETTINGS_NS = 'dsh-modal'

type Snapshot = {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  value?: Record<string, unknown>
  base?: unknown
  user?: unknown
  revision?: number
}

type Scope = {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

type Field = {
  readonly section: 'routing' | 'remote'
  readonly key: string
  readonly label: string
  readonly help: string
  readonly kind: 'number' | 'select' | 'text'
  readonly options?: readonly string[]
}

const FIELDS: readonly Field[] = [
  { section: 'routing', key: 'mode', label: 'Routing mode', help: 'strict routes and refuses unroutable builds; auto lets them run locally; off disables routing.', kind: 'select', options: ['strict', 'auto', 'off'] },
  { section: 'routing', key: 'onUnroutable', label: 'On unroutable build', help: 'deny fails closed (protects a small host); local falls back to this machine.', kind: 'select', options: ['deny', 'local'] },
  { section: 'remote', key: 'toolchain', label: 'Toolchain', help: 'Rust is the supported toolchain; generic is a fallback for an unknown name.', kind: 'select', options: ['rust', 'generic'] },
  { section: 'remote', key: 'lanes', label: 'Lanes', help: 'Warm sandboxes per project. Parallel agents use different lanes.', kind: 'number' },
  { section: 'remote', key: 'maxLanesPerProject', label: 'Max lanes', help: 'Hard cap on simultaneous lanes, and so on idle spend.', kind: 'number' },
  { section: 'remote', key: 'cpu', label: 'CPU cores', help: 'Modal bills max(request, actual); sandboxes burst above the request, so a low value keeps idle cheap.', kind: 'number' },
  { section: 'remote', key: 'memoryMiB', label: 'Memory (MiB)', help: 'Not safe to under-request: the linker is memory-bound.', kind: 'number' },
  { section: 'remote', key: 'idleSeconds', label: 'Idle timeout (s)', help: 'How long a lane stays warm before it is checkpointed and released.', kind: 'number' },
]

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4, color: 'var(--dsw-alias-label-secondary, #555)' }
const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #ccc)', background: 'var(--dsw-alias-bg-layer-3, #fff)', color: 'var(--dsw-alias-label-primary, #111)' }
const helpStyle: React.CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #777)', marginTop: 2 }
const saveStyle: React.CSSProperties = { padding: '8px 16px', borderRadius: 6, border: 'none', background: 'var(--dsw-alias-label-primary, #111)', color: 'var(--dsw-alias-bg-layer-3, #fff)', cursor: 'pointer' }
const secondaryStyle: React.CSSProperties = { ...saveStyle, background: 'transparent', color: 'var(--dsw-alias-label-primary, #111)', border: '1px solid var(--dsw-alias-border-l2, #ccc)' }

/** Read one nested value out of the resolved settings snapshot. */
function readValue(snap: Snapshot, field: Field): unknown {
  const section = snap.value?.[field.section]
  if (section === null || typeof section !== 'object') return undefined
  return (section as Record<string, unknown>)[field.key]
}

/** Project the snapshot into editable strings, exposing idle time in seconds. */
function toDraft(snap: Snapshot): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of FIELDS) {
    if (field.key === 'idleSeconds') {
      const ms = readValue(snap, { ...field, key: 'idleTimeoutMs' })
      out[`${field.section}.${field.key}`] = ms === undefined ? '' : String(Number(ms) / 1000)
      continue
    }
    const value = readValue(snap, field)
    out[`${field.section}.${field.key}`] = value === undefined || value === null ? '' : String(value)
  }
  return out
}

function Card({ scope }: { scope: Scope }) {
  const [snap, setSnap] = React.useState<Snapshot>(() => scope.getSnapshot())
  const [draft, setDraft] = React.useState<Record<string, string>>(() => toDraft(scope.getSnapshot()))
  const [status, setStatus] = React.useState('')

  React.useEffect(() => {
    const unsubscribe = scope.subscribe(() => {
      const next = scope.getSnapshot()
      setSnap(next)
      setDraft(toDraft(next))
    })
    return unsubscribe
  }, [scope])

  const dirty = React.useMemo(() => {
    const current = toDraft(snap)
    return FIELDS.some(field => draft[`${field.section}.${field.key}`] !== current[`${field.section}.${field.key}`])
  }, [draft, snap])

  /**
   * Write every changed field, one whole nested section at a time.
   */
  const save = async (): Promise<void> => {
    setStatus('saving…')
    try {
      for (const section of ['routing', 'remote'] as const) {
        const changed = FIELDS.filter(f => f.section === section && draft[`${section}.${f.key}`] !== toDraft(snap)[`${section}.${f.key}`])
        if (changed.length === 0) continue
        const existing = snap.value?.[section]
        const merged: Record<string, unknown> = existing !== null && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {}
        for (const field of changed) {
          const raw = draft[`${section}.${field.key}`] ?? ''
          if (field.kind === 'number') {
            const parsed = Number(raw)
            if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field.label} must be a positive number`)
            merged[field.key === 'idleSeconds' ? 'idleTimeoutMs' : field.key] = field.key === 'idleSeconds' ? Math.round(parsed * 1000) : parsed
          } else {
            merged[field.key] = raw
          }
        }
        await scope.set(section, merged)
      }
      setStatus('saved — applies to the next command')
    } catch (error) {
      setStatus(`error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reset = async (): Promise<void> => {
    setStatus('resetting…')
    try {
      await scope.unset('routing')
      await scope.unset('remote')
      setStatus('reset to the composition defaults')
    } catch (error) {
      setStatus(`error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 4 } },
    React.createElement(
      'p',
      { style: { ...helpStyle, margin: 0, fontSize: 12 } },
      'Build commands run on a Modal sandbox; reads, greps and edits stay local. A build that cannot be routed safely is refused rather than run on this machine.',
    ),
    React.createElement(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 } },
      ...FIELDS.map(field => {
        const id = `${field.section}.${field.key}`
        const value = draft[id] ?? ''
        const onChange = (next: string): void => setDraft(prev => ({ ...prev, [id]: next }))
        const control =
          field.kind === 'select'
            ? React.createElement(
                'select',
                { id, style: inputStyle, value, disabled: !snap.writable, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.currentTarget.value) },
                ...(field.options ?? []).map(option => React.createElement('option', { key: option, value: option }, option)),
              )
            : React.createElement('input', {
                id,
                style: inputStyle,
                value,
                disabled: !snap.writable,
                inputMode: field.kind === 'number' ? 'numeric' : undefined,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.currentTarget.value),
              })
        return React.createElement(
          'div',
          { key: id },
          React.createElement('label', { htmlFor: id, style: labelStyle }, field.label),
          control,
          React.createElement('div', { style: helpStyle }, field.help),
        )
      }),
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      React.createElement('button', { type: 'button', style: saveStyle, disabled: !snap.writable || !dirty, onClick: () => void save() }, 'Save'),
      React.createElement('button', { type: 'button', style: secondaryStyle, disabled: !snap.writable, onClick: () => void reset() }, 'Reset'),
      React.createElement('span', { style: helpStyle }, status),
    ),
    snap.status !== 'ready'
      ? React.createElement('div', { style: helpStyle }, `settings ${snap.status}`)
      : null,
    React.createElement(
      'div',
      { style: helpStyle },
      'Live lane and spend figures are in ',
      React.createElement('code', null, '$DSH_HOME/modal/<project>.json'),
      '.',
    ),
  )
}

export const inject = ['slots', 'settingsScope']

export function apply(ctx: {
  settingsScope: { bind(options: { namespace: string }): Scope }
  slots: {
    inject(name: string, callback: () => unknown): void
    register(
      options: { name: string; key: string; inject: () => Record<string, unknown> },
      component: (props: { scope: Scope }) => unknown,
    ): unknown
  }
}): void {
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS })
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      { name: 'settings.plugin.item', key: SETTINGS_NS, inject: () => ({ scope }) },
      (props: { scope: Scope }) => React.createElement(Card, { scope: props.scope }),
    ),
  )
}
