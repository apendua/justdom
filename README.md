# justdom

A reactive, non-VDOM renderer for the DOM and for Three.js, built on signals.

## Packages

| Package | What it is |
| --- | --- |
| [`justdom`](packages/justdom) | Reactive, non-VDOM DOM renderer built on `justdom-signal`, with SSR and hydration support |
| [`justdom-signal`](packages/signal) | A dependency-tracked reactive signals library built on RxJS |
| [`justdom-three`](packages/three) | Reactive Three.js scene graph, with WebXR helpers and a DOM-in-scene bridge |
| [`justdom-three-ui`](packages/three-ui) | The widgets a panel is made of, built out of ordinary DOM so they work on a page and inside a `justdom-three` portal alike |
| [`justdom-vite-hmr`](packages/vite-hmr) | A Vite plugin that preserves component state across hot module reloads |

`@justdom/jsdom-env` (in [`packages/jsdom-env`](packages/jsdom-env)) installs a JSDOM window on
`globalThis` so DOM code can run under `node:test`. It is a development
dependency of the packages above and is not published.

## Examples

| App | What it shows |
| --- | --- |
| [`showcase`](apps/showcase) | Every element in the Three.js renderer, in one scene, viewable in an emulated headset |
| [`todo`](apps/todo) | The smallest useful `justdom` app, as a PWA |
| [`todo-xr`](apps/todo-xr) | The same list, rendered into a WebXR scene with a keyboard you can point at |
| [`todo-ssr`](apps/todo-ssr) | The same list again, rendered by express inside jsdom and hydrated in the browser |

## Getting started

To execute rush commands, make sure you have rush installed globally:

```
npm install -g @microsoft/rush
```

Then, you should be able to run:

```
rush install
rush build
```

To run one app:

```
cd apps/todo
rushx dev
```

## Releasing

Every change to a published package needs a change file, which `rush change`
writes and CI verifies:

```
rush change
```

Pushing to `develop` runs [the Release workflow](.github/workflows/release.yml).
It publishes any version not yet on the registry, then opens a pull request
that applies the accumulated change files and bumps the versions. **Merge that
pull request with a merge commit** — a squash or rebase would carry its
`[skip ci]` marker onto `develop` and the bumped versions would not go out.

## Updating browserslistrc

Check latest version of `caniuse-lite` [here](https://www.npmjs.com/package/caniuse-lite) and update the version in `common/config/rush/common-versions.json` accordingly. Next, do the same for `baseline-browser-mapping` [here](https://www.npmjs.com/package/baseline-browser-mapping). Finally, run:

```
rush update
rush update-autoinstaller browserslist-tools
rush browserlist
```
