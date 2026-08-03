# @apendua/vite-hmr

A Vite plugin that lets components built with
[`@apendua/signal`](../signal) and [`@apendua/justdom`](../justdom) survive hot
module reloads without losing their live reactive state.

## The problem it solves

Vite's default HMR replaces an edited module wholesale. For most UI code
that's fine — the framework re-renders from scratch. But this monorepo's
stack has no virtual DOM and no re-render step: a component is just a
subscription that closes over signals and already-mounted DOM/Three.js
nodes directly. Reloading the module naively would tear down and remount the
whole subtree, losing whatever state lived only in memory (an open panel,
scroll position, an in-progress drag).

## Usage

```js
// vite.config.mts
import { defineConfig } from "vite";
import HMRPlugin from "@apendua/vite-hmr/plugin";

export default defineConfig({
  plugins: [HMRPlugin()],
});
```

The plugin transforms modules at dev-serve time: any locally-defined,
exported function assigned from an import flagged as `reloadable` for its
source package (currently `component` from `@apendua/signal`, and
`stylesheet` / `className` / `fontFace` from `@apendua/justdom`) gets wrapped
with `$reloadable(name, fn)`. On an HMR update, the wrapped definitions swap
their implementation in place through a `BehaviorSubject` instead of
remounting, so already-mounted instances keep their state and simply start
running the new code on the next reactive tick.

`$reloadable` / `$newReloader`, exported from the package root, are the
runtime half of the plugin and are injected automatically into transformed
modules — they are not meant to be imported or called directly.

## Scope

The set of reloadable factories is currently hardcoded in `src/plugin.js` to
what this monorepo's own packages export. This is not a general-purpose
"preserve state across HMR" plugin for arbitrary code — only for the
`component` / `stylesheet` / `className` / `fontFace` factories from
`@apendua/signal` and `@apendua/justdom`.

## License

MIT — see [LICENSE](../../LICENSE).
