# Development

Working on an app built on these packages: keeping live state across a hot reload, seeing what a
panel re-measures and why, reading a stylesheet edit in the room, and watching the frame rate where
it matters.

## Hot reloading with live state

Vite's default HMR replaces an edited module wholesale. A tree built on `justdom` has no re-render
step: a component is a subscription that closes over signals and already-mounted nodes, so reloading
the module naively would tear the subtree down and lose whatever lived only in memory, an open panel
or an in-progress drag. [`justdom-vite-hmr`](/api/vite-hmr) is a Vite plugin that swaps definitions
in place instead:

```js
// vite.config.mts
import { defineConfig } from "vite";
import HMRPlugin from "justdom-vite-hmr/plugin";

export default defineConfig({ plugins: [HMRPlugin()] });
```

That is all. A component edited in a module is replaced where it is mounted and whoever mounted it
keeps its state; a `Signal`, a `ReactiveMap` or a context property exported from the module is kept,
since what it holds is what the running app put there; a `store` is kept and reshaped, so an edited
colour in a theme reaches the things wearing it without a reload. The plugin runs at dev-serve time
and never in a production build.

## Seeing what a panel does

Two modes in `justdom-three` are for working on a panel's CSS, and the demos turn each on with a
query parameter through `justdom-xr/theming`:

```js
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";

const query = new URLSearchParams(location.search);
followThemingQuery(query); // ?theming
followOutlinesQuery(query); // ?outlines
```

**Theming mode** follows rules edited, added or switched off in the browser's developer tools, which
a panel otherwise misses because a mutation observer cannot see the CSSOM. It reads every rule's
text on a timer, so a drag across the colour picker lands as one restyle per read. **Outlines mode**
draws a rectangle round each element of a panel that changed, coloured by how often and styled by
why: the page changed it, something it reads came out different, or the mirror measured it again for
nothing, which is where a gap in the mirror's filtering shows. `outlinesReport()` lists the busiest
elements for a headset, where the outlines are hard to read. Both cost frame time, so measure with
them off. [Development tools](/api/three/tooling) in the reference reads the colours.

## The frame rate, in the room

A frame rate readout in the corner of the page measures the desktop preview, which is the one
reading nobody needs: once the headset takes the display, the page stops being drawn.
`useDiagnostics(ctx, controls)` from [`justdom-three-ui`](/api/three-ui#diagnostics) draws the same
reading head-locked in the room, with a minute of history as bars coloured against the display's own
rate. It is faint, lets rays through, and draws over the scene rather than in it.

```js
const diagnostics = createDiagnostics();
useEffects(getScene(ctx), [effects(() => useDiagnostics(ctx, diagnostics))]);
```

Anything that photographs a scene for comparison should put it down first with
`diagnostics.visible.set(false)`, since a live number never matches the picture before.

## Driving a headset from a script

`install()` from `justdom-xr/emulator` leaves the emulated device on `window.xrDevice`, and
`justdom-xr/driver` is what a Node script imports to drive it in headless Chromium: launch, wait for
frames, aim a controller's ray at a point, press the trigger, and tally what it checked. Four of the
demos carry such a check in `tests/xr-check.mjs`; each app's README says what its check does.

## Testing without a browser

The packages' own tests run under `node --test` against
[`@apendua/jsdom-env`](https://github.com/apendua/justdom/tree/develop/packages/jsdom-env), which
installs a jsdom window on `globalThis`. A widget built out of elements is tested as a page, and a
portal mounts synchronously where there are no frames to slice across, so a panel can be raised and
measured in a test too.
