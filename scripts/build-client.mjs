/**
 * Bundles the browser half.
 *
 * `src/client.tsx` cannot go through `tsc -b`: the host build has no JSX
 * transform and the client bundle must not pull React or the client packages
 * into itself. They are external because the Web Client provides them.
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // Classic transform: the source imports React and calls React.createElement.
  jsx: 'transform',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  logLevel: 'info',
})
