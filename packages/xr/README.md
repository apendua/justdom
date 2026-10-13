# @apendua.dev/headset

What every app with a headset session repeats, kept in one place: the emulated headset behind
`?emulator`, the offer of a session to a page that can have one, freedom's theming mode behind
`?theming` and its outlines mode behind `?outlines`, whether the platform can present at all, the
session a page reads for the controls that only make sense in a headset, and what a scene draws
round the panels: the backdrop, and the controller and hand models. Private to this repository.

It has five entries for a page and no index, so that an app importing one does not pull in the
others. The emulator brings IWER and its dev UI with it, over half a megabyte, and is meant to be
imported lazily; the offer and the session import nothing from three.js, so a page can load them
before it knows whether it will ever make a scene; the scene entry and theming import three.js and
freedom, and belong in the chunk that makes the scene. A sixth entry, the driver, is for the apps'
check scripts.

## `@apendua.dev/headset/emulator`

```ts
const query = new URLSearchParams(location.search);
if (query.has("emulator")) {
  const { install } = await import("@apendua.dev/headset/emulator");
  install({ devUI: query.get("emulator") !== "bare" });
}
```

`install` puts an emulated Quest 3 in an ordinary browser and returns it. It forces IWER's runtime
in, since a desktop browser has a `navigator.xr` of its own that supports nothing and IWER would
otherwise step aside for it. It also leaves the device on `window.xrDevice`, which is how the apps'
check scripts drive the headset and controllers in headless Chromium.

- `devUI` (default `true`) draws IWER's panels over the page. `?emulator=bare` is the apps'
  convention for leaving them out, for a script that sets the poses itself or photographs the scene.
  Without them both controllers start turned half round, pointing away from the scene, where IWER
  would rest them in front of the head with their rays on whatever the scene puts there. A script
  aims one hand at a time, and the hand it has not aimed would otherwise go on pointing at a panel:
  the page would hear two pointers in every step, and the other hand's moves could undo what the
  script checks. With the dev UI they rest where IWER puts them, for a person to pick up.
- `keyMap` moves the dev UI's controllers to other keys, by hand and by the dev UI's name for the
  input (`thumbstick-up`, `trigger`, `squeeze`, `pose`, ...). Its defaults are WASD, the arrow keys
  and Q/E/R, so a game that listens to those on a desktop gets every press twice in the dev UI's
  play mode. `kite-xr` and `blockout-xr` each pass one, from their `src/emulatorKeys.ts`.

Installing it also answers WebGL's three clear-state queries from a shadow kept by `clearColor`,
`clearDepth` and `clearStencil` (`src/clearState.js`). IWER reads them around its own clear every
frame, and each read is a pipeline sync that stalls the emulated session for as long as the GPU
takes to finish the frame. Nothing on a headset runs it.

It also mends IWER's `getOffsetReferenceSpace` (`src/offsetSpaces.js`). IWER 2.4.0 and 2.5.0 take
the `XRRigidTransform` it is given for a matrix, so every offset space came out offset by NaN and
was drawn from whatever space the previous pose call measured. freedom's `anchorToViewer` builds an
offset space for every session; it now drops one that comes out as NaN and leaves three on the space
it requested, which is what happens in the Immersive Web Emulator extension. The fix is what lets
the anchor run in full under this emulator.

Import it lazily, as above, so that it lands in a chunk of its own, named `emulator-<hash>.js`. A
service worker that precaches the app should leave that chunk out; `hexboard-xr` and `paperplane-xr`
do it with `globIgnores: ["**/emulator-*.js"]`.

## `@apendua.dev/headset/offer`

```ts
import { offerHeadset } from "@apendua.dev/headset/offer";

offerHeadset(() => import("./xr")).then((xr) => xr?.offerXR(board, menu));
```

`offerHeadset(scene)` offers the page a headset if it can have one. It installs the emulator first
behind `?emulator` (`?emulator=bare` for no dev UI), asks `canPresent()`, and only then calls
`scene`, a dynamic import of the module that makes the renderer and the scene, and resolves to that
module, or to null on a platform that cannot present. Nothing here imports three.js, so on a laptop
the page is the page and the scene's chunk, with three.js in it, is never fetched.

If the emulator's chunk or the scene's cannot be fetched because the page came from a service
worker's precache and a deploy has replaced the chunks it names, the page reloads once a newer
worker has taken it over, and at once if one already has. A page whose worker has not been replaced
has no newer page to reload into, so it waits rather than loops. Minesweeper, Euclid, Knights and
the todo app offer their sessions this way.

## `@apendua.dev/headset/scene`

What the scene of a headset app repeats. It imports three.js and freedom, so import it from the
module that makes the scene, never from the page's entry.

- `Backdrop(color)` is a sphere of one colour round the viewer, shown while `backdropShown()` says
  so. In an `alpha-blend` session three clears the frame to transparent whatever `scene.background`
  says, so that the passthrough shows; the sphere is a background three has no rule about. It is
  drawn first and takes no part in the depth test. A scene sets its `background` to the same colour
  for a VR session, where three honours it.
- `inputModels(base)` returns `createControllerModel` and `createHandModel` for `render()`'s
  options, reading the models from the app's own origin rather than three's default CDN, so no other
  origin is asked for them. A headset with no network draws them only if the app's service worker
  precaches them (`@apendua.dev/media`'s README says how); each app's README says whether it does.
  `base` is the app's `import.meta.env.BASE_URL`, and the app's `vite.config.mts` has to list
  `@apendua.dev/media/vite`'s plugin, which serves the vendored WebXR input profiles at
  `<base>profiles/`; `@apendua.dev/media`'s README says what is in them.
- `clientRect(element)` is the element's client rect, read again whenever the element is resized:
  called inside a panel's `effects`, it runs them again on each resize. A scale worked out from it
  follows the element when the window is resized during a session, rather than keeping the one it
  had as the session started.

```ts
dom(ctx, board, [
  effects((o) => {
    const { width, height } = clientRect(board);
    o.scale.setScalar(boardScale(width, height));
  }),
]);
```

## `@apendua.dev/headset/theming`

```ts
import { followOutlinesQuery, followThemingQuery } from "@apendua.dev/headset/theming";

const query = new URLSearchParams(location.search);
followThemingQuery(query);
followOutlinesQuery(query);
```

`followThemingQuery(query)` turns on freedom's `enableThemingMode()` when the query has `?theming`,
and returns what turns it off again, or null when the query did not ask. The panels then follow
rules edited, added or switched off in the browser's developer tools, which they otherwise miss;
"Stylesheets" in freedom's README says what it reads and what that costs. The apps never turn it
off, so it stays on for the life of the page. Every app built on freedom calls it next to where it
reads `?emulator`, or where it calls `render()` when the module that reads `?emulator` imports
nothing from three.js. `paperplane-xr` calls it in its labs edition only.

`followOutlinesQuery(query)` is the same switch for freedom's `enableOutlinesMode()` and
`?outlines`: every panel outlines the elements that change, and the ones the mirror measures again
for nothing. "Outlines" in freedom's README says how to read them. Every app calls it on the line
after `followThemingQuery`.

This entry imports `@apendua/freedom`, so import it only from a module that already does.

## `@apendua.dev/headset/session`

- `canPresent()` resolves to whether the platform can open an `immersive-ar` or `immersive-vr`
  session. Ask it before making a scene, a renderer or an Enter button, and after installing the
  emulator, which is what answers it in a desktop browser.
- `xrSession` is a signal holding the session the page is shown in, or null. The scene writes it,
  usually through `enterSession(getXRSession(ctx))`, and the page reads it, since a page is mounted
  before there is a renderer to ask.
- `enterSession(session)` records a session starting or ending, and turns the passthrough off with
  it: every session starts in a room of its own.
- `passthrough` is the switch, `canPassThrough()` says whether the session can show the room and
  hide it again (only an `alpha-blend` one), and `backdropShown()` says whether an opaque backdrop
  should stand round the viewer: in a session, unless the room has been asked for and can be had.

The signals are module state, one set per page.

## `@apendua.dev/headset/driver`

What an app's `tests/xr-check.mjs` imports to drive a session on the emulated headset from Node,
through the device `install` leaves on `window.xrDevice`: `launch()` for Chromium on SwiftShader,
`frames(page, n)` to wait for frames, `headPosition(page)` for the origin of the `local` space,
`aimAt(page, head, target)` to point the right controller's ray through a point, while the left one
stays turned away as `install` left it, `rotate(v, pitch, yaw)` to turn a point on a panel into the
scene by the panel's angles, `press(page, "trigger" | "squeeze")`, `hold(page, button, 1 | 0)` to
close or open a button for a drag, and `check`, `finish` and `closeAll` for the tally, the exit code
and the teardown. It is in `driver/` rather than `src/`, since it runs in Node and never in a page.
It borrows Playwright from `apps/showcase-xr` and launches the Chromium at
`/opt/pw-browsers/chromium-1194`, or the one `CHROMIUM` names. `precache(build, root)` builds an app
with its own Vite and says which chunks its service worker precaches and which the page loads, for a
check that holds the two equal; minesweeper's check and the todo app's drag check use it.
Minesweeper's, the desk's, Euclid's and Knights' checks use the rest, and
`.github/workflows/driven.yml` runs all four on pull requests.

## Tests

`npm test` here, or `rush build --to @apendua.dev/headset`, runs `node --test` over `src`: the
session's rules, `canPresent` against a stubbed `navigator.xr`, the offer against a stubbed platform
and service worker, the controller and hand models' addresses against a stubbed `fetch`,
`clientRect` against a stand-in `ResizeObserver`, the clear-state shadow against a stand-in WebGL
context, which queries `followThemingQuery` takes for `?theming` and `followOutlinesQuery` for
`?outlines`, and that each hands back freedom's off switch, and the offset-space fix against IWER's
own `XRReferenceSpace`, including a test that fails once IWER fixes it and the fix can go. `install`
itself needs a browser, and is exercised by the apps' own check scripts, as is the driver.
