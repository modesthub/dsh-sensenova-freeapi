import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the published bundle: transpile src/ to ESM under
 * lib/ without project references or type checking. Peer packages stay external.
 *
 * The second config emits the browser client bundle (lib/client.js) from
 * src/client/index.ts. The host's client-modules scanner loads any bundle that
 * declares `dsh.client` + `exports["./client"]`; the artifact must call
 * `window.__ModuleLoader__.load({ id, factory })`. The client half only imports
 * platform modules (`react`, primitives) resolved from the loader's module table
 * at runtime, so those stay external too.
 */
const lib = defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'lib',
  clean: true,
  sourcemap: true,
  dts: true,
  // 🔴 tsdown 0.23 把 outExtension（单数）改名为 outExtensions（复数）。
  // 用旧名会静默失效 ⇒ ESM 产物落成 index.mjs/index.d.mts，而 package.json 的
  // main/types/exports 全部指向 index.js/index.d.ts ⇒ 插件加载直接失败。
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-settings',
  ],
})

const client = defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  dts: false,
  clean: false,
  external: [
    '@deepseek-ai/cordis',
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-sensenova-freeapi')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

export default [lib, client]
