# justdom-vite-hmr

A Vite plugin that lets modules built on [`justdom-signal`](../signal) and [`justdom`](../justdom)
survive hot module reloads without losing their live reactive state.

Vite's default HMR replaces an edited module wholesale. A tree built on `justdom` has no virtual DOM
and no re-render step: a component is a subscription that closes over signals and already-mounted
DOM or Three.js nodes. Reloading the module naively would tear down and remount the whole subtree,
losing whatever state lived only in memory: an open panel, a scroll position, an in-progress drag.
The plugin instead makes every export of a module a stand-in that follows the module, so a reload
swaps the definition in place and the state stays.

## Installation

```
npm install --save-dev justdom-vite-hmr
```

## Usage

```js
// vite.config.mts
import { defineConfig } from "vite";
import HMRPlugin from "justdom-vite-hmr/plugin";

export default defineConfig({
  plugins: [HMRPlugin()],
});
```

That is all. The plugin transforms modules at dev-serve time and never runs in a production build.

## Learn more

- [Development](https://justdom.dev/guide/development) in the guide says what a reload keeps and
  what it replaces.
- The [API reference](https://justdom.dev/api/vite-hmr) describes what the stand-in does for each
  kind of export, what the transform does to a module, and which modules it leaves alone.

## License

MIT — see [LICENSE](../../LICENSE).
