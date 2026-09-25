/**
 * Bundles the browser half.
 *
 * `src/client.tsx` cannot go through `tsc -b`: the host build has no JSX
 * transform. The emitted artifact must be in the client module system's
 * closure-factory format — a classic script that calls
 * `window.__ModuleLoader__.load({id, factory})` and answers its imports through
 * the injected `require` — not an ES module. The host concatenates every
 * plugin's `client.js` into one classic combo script, so a bundle carrying
 * top-level `import`/`export` is a parse error that takes the whole batch down
 * and the browser page reports "Failed to load plugins".
 *
 * React and the client packages stay external: the browser shell supplies them
 * from its module table, and the factory's `require` resolves them.
 */
import { build } from 'esbuild'

/** Module-table specifiers the browser shell seeds; each must stay a `require()` call. */
const MODULE_TABLE_EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/*',
]

await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  // Classic transform: the source imports React and calls React.createElement.
  jsx: 'transform',
  external: MODULE_TABLE_EXTERNAL,
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-modal", factory: (require) => {\n'
      + '"use strict";\n'
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
