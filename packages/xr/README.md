# @apendua.dev/headset

What every app with a headset session repeats, kept in one place: the emulated headset behind
`?emulator`, whether the platform can present at all, and the session a page reads for the controls
that only make sense in a headset. Private to this repository.

It has three entries for a page and no index, so that an app importing one does not pull in the
others. The emulator brings IWER and its dev UI with it, over half a megabyte, and is meant to be
imported lazily; the session is a few signals. A fourth entry, the driver, is for the apps' check
scripts.

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
was drawn from whatever space the previous pose call measured. freedom's `anchorToViewer` hands
three an offset space for every session, so without the fix the emulator drew the scene from the
wrong origin, or from the right one by luck.

Import it lazily, as above, so that it lands in a chunk of its own, named `emulator-<hash>.js`. A
service worker that precaches the app should leave that chunk out; `hexboard-xr` and `paperplane-xr`
do it with `globIgnores: ["**/emulator-*.js"]`.

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

## `@apendua.dev/headset/focus`

An experiment. `followXRFocus(root)` gives the page's focus to the field under `root` that freedom's
keyboard is typing into, and takes it away when the keyboard goes. A ray's press is a click freedom
dispatches itself, which moves no focus, so in a session a field is only ever focused in freedom's
own sense: it carries `data-xr-focus`. Following that mark with `focus()` and `blur()` lets a
keyboard paired with the headset, or the laptop's under the emulator, type into the field. The todo
app and the desk turn it on behind `?realfocus`; `apps/todo-vanilla/tests/focus-check.mjs` runs it
on the emulated headset.

## `@apendua.dev/headset/driver`

What an app's `tests/xr-check.mjs` imports to drive a session on the emulated headset from Node,
through the device `install` leaves on `window.xrDevice`: `launch()` for Chromium on SwiftShader,
`frames(page, n)` to wait for frames, `headPosition(page)` for the origin of the `local` space,
`aimAt(page, head, target)` to point the right controller's ray through a point,
`rotate(v, pitch, yaw)` to turn a point on a panel into the scene by the panel's angles,
`press(page, "trigger" | "squeeze")`, `hold(page, button, 1 | 0)` to close or open a button for a
drag, and `check`, `finish` and `closeAll` for the tally, the exit code and the teardown. It is in
`driver/` rather than `src/`, since it runs in Node and never in a page. It borrows Playwright from
`apps/showcase-xr` and launches the Chromium at `/opt/pw-browsers/chromium-1194`, or the one
`CHROMIUM` names. Minesweeper's, the desk's and Euclid's checks use it, and
`.github/workflows/driven.yml` runs all three on pull requests.

## Tests

`npm test` here, or `rush build --to @apendua.dev/headset`, runs `node --test` over `src`: the
session's rules, `canPresent` against a stubbed `navigator.xr`, the clear-state shadow against a
stand-in WebGL context, and the offset-space fix against IWER's own `XRReferenceSpace`, including a
test that fails once IWER fixes it and the fix can go. `install` itself needs a browser, and is
exercised by the apps' own check scripts, as is the driver.
