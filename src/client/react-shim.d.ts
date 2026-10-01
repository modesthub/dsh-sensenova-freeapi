/**
 * 最小 React / JSX 类型垫片，仅供 `tsc --noEmit` 类型检查使用。
 *
 * 宿主 Web 端在运行时由 `window.__ModuleLoader__` 的模块表提供真实的
 * `react` 与 `react/jsx-runtime`，客户端产物不打包它们；而 @types/react
 * 未安装在共享 profile node_modules 中（也不应污染该目录）。这里只声明
 * 本插件客户端用到的极小子集：useState、jsx/jsxs/Fragment 与 JSX 内建元素
 * 索引，足以让 .tsx 通过严格类型检查。发布包不含此文件（lib/client.js
 * 由 tsdown 直接转译，运行时类型来自宿主模块表）。
 */
declare module 'react' {
  export function useState<S>(initialState: S | (() => S)): [S, (value: S | ((prev: S) => S)) => void];
  export function useState<S = undefined>(): [S | undefined, (value: S | undefined | ((prev: S | undefined) => S | undefined)) => void];
}

declare module 'react/jsx-runtime' {
  export function jsx(type: unknown, props: unknown, key?: string): unknown;
  export function jsxs(type: unknown, props: unknown, key?: string): unknown;
  export const Fragment: unknown;
}

declare namespace JSX {
  type Element = unknown;
  interface IntrinsicAttributes {
    key?: string | number | null | undefined;
  }
  interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>;
  }
}
