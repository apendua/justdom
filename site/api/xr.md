# justdom-xr

What every app with a headset session repeats, kept in one place: the emulated headset behind
`?emulator`, the phone's touch layer over it behind `?touch`, the offer of a session to a page that
can have one, `justdom-three`'s theming mode behind `?theming` and its outlines mode behind
`?outlines`, whether the platform can present at all, the session a page reads for the controls that
only make sense in a headset, and what a scene draws round the panels: the backdrop, and the
controller and hand models.

```
npm install justdom-xr justdom-three justdom-signal three
```

`three` is a peer dependency; `justdom-three`, `justdom-signal` and the emulator's `iwer` and
`@iwer/devui` are dependencies. The package has six entries for a page and no index, so that an app
importing one does not pull in the others. The emulator brings IWER and its dev UI with it, over
half a megabyte, and is meant to be imported lazily, as is the touch layer; the offer and the
session import nothing from three.js, so a page can load them before it knows whether it will ever
make a scene; the scene entry and theming import three.js and `justdom-three`, and belong in the
chunk that makes the scene. A seventh entry, the driver, is for the apps' check scripts and runs in
Node.

## `justdom-xr/emulator`

```ts
const query = new URLSearchParams(location.search);
if (query.has("emulator")) {
  const { install } = await import("justdom-xr/emulator");
  install({ devUI: query.get("emulator") !== "bare" });
}
```

`install(options)` puts an emulated Quest 3 in an ordinary browser and returns the `XRDevice`. It
forces IWER's runtime in, since a desktop browser has a `navigator.xr` of its own that supports
nothing and IWER would otherwise step aside for it. It also leaves the device on `window.xrDevice`,
which is how the apps' check scripts drive the headset and controllers in headless Chromium.

| Option   | Default | What it does                                                                                                                                                                                                                                                                                                      |
| -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devUI`  | `true`  | Draws IWER's panels over the page. `?emulator=bare` is the apps' convention for leaving them out, for a script that sets the poses itself or photographs the scene. Without them both controllers start turned half round, pointing away from the scene, so that no ray reaches anything until a script aims one. |
| `keyMap` | IWER's  | Moves the dev UI's controllers to other keys, by hand and by the dev UI's name for the input (`thumbstick-up`, `trigger`, `squeeze`, `pose`, …). The defaults are WASD, the arrow keys and Q/E/R, so a game that listens to those on a desktop gets every press twice in the dev UI's play mode.                  |

Installing it also answers WebGL's three clear-state queries from a shadow kept by `clearColor`,
`clearDepth` and `clearStencil` (`src/clearState.js`). IWER reads them around its own clear every
frame, and each read is a pipeline sync that stalls the emulated session for as long as the GPU
takes to finish the frame. Nothing on a headset runs it.

Import it lazily, as above, so that it lands in a chunk of its own, named `emulator-<hash>.js`. A
service worker that precaches the app should leave that chunk out; `minesweeper` and `todo` do it
with `globIgnores: ["**/emulator-*.js"]`.

## `justdom-xr/touch`

```ts
import { install } from "justdom-xr/emulator";
import { installTouch } from "justdom-xr/touch";

installTouch(install({ devUI: false }), {
  buttons: [{ label: "Throw", code: "Space" }],
});
```

`installTouch(headset, options)` puts a phone's touch screen in front of the emulated headset, so a
headset app can be played on a phone. It puts a layer over the page while a session is up, and only
then, so the page's own buttons, the one that starts the session among them, are tapped as they
always are. It learns of the session by wrapping the emulated `navigator.xr.requestSession`, so call
it after `install` and before the page asks for a session. `offerHeadset` does both for `?touch`.

A finger on the scene is undecided until it does one of four things:

- **Look.** Moving more than 10 CSS px from where it landed turns the head: the scene follows the
  finger, by the angle the screen shows over that many pixels, and the head never tips past 1.4 rad
  up or down. A look presses nothing.
- **Tap.** Lifting within 10 px aims the right controller through the tapped pixel, from just behind
  the eye, and pulls its trigger: aim, 4 frames, trigger down, 4 frames, trigger up, 4 frames, then
  the controller is parked again. A tap that lands while the last one is still running is dropped.
- **Hold.** Staying within 10 px for 400 ms (`HOLD_MS`) aims the right controller the same way and
  presses nothing yet. What the finger does next decides the press:
  - **Drag.** Moving more than 10 px from where it landed pulls the trigger 4 frames later where the
    finger landed, and a finger that only jitters in place never gets that far. From 4 frames after
    the trigger the ray follows the finger, the head stays where it is, and the lift, or the
    browser's cancel, lets the trigger go and parks the controller 4 frames after. A finger lifted
    before the trigger went down keeps it down for 4 frames, so the app sees the press; one the
    browser cancels by then presses nothing. This is what drags a panel's rows, cards and handles,
    and `drag()`'s things.
  - **Long press.** Lifting within 10 px presses the grip: 4 frames, grip down, 4 frames, grip up, 4
    frames, parked. That is the right button on a panel, a `contextmenu`.

  A hold never turns the head. A hold that starts while a tap is still running is dropped the same
  way: the finger then turns nothing and its lift presses nothing. A hold the browser cancels
  presses nothing.

- **Pinch.** A second finger that lands while the first is undecided or looking zooms the view as
  the page's pointer does: spreading the fingers twice as far apart draws the view twice as large
  (the tangent of half the vertical field of view goes inversely with the spread), between 20°
  (`MIN_FOVY`, the narrowest `justdom-three`'s pointer zooms to as well) and the headset's own 90°.
  A pinch cancels the first finger's tap and hold, and turns nothing. It ends when either finger
  lifts, and the one left does nothing until it lifts too. The zoom stays where the pinch left it. A
  tap's and a hold's ray, and a look's turn for each pixel, follow the field of view, so they work
  the same at any zoom.

A second finger is ignored while the first is holding or dragging, and a third always is. Unlike the
page's pointer, the layer cannot move a held thing nearer or further with a pinch: the thing hangs
off the emulated controller, and the layer could only move it by moving the controller into the
view. The limits (`HOLD_MS`, `SLOP_PX`, `PITCH_LIMIT`, `MIN_FOVY`) are `justdom-three`'s,
re-exported here. Parked, both controllers sit under the head, turned with it, pointing at the
floor, so neither model nor ray is in the view. `installTouch` sets `ipd` to 0, so the session is
drawn from the head and a ray from the head lands on the pixel touched. The session ending hides the
layer, lets go of the trigger and the grip, parks the controllers at once, forgets the fingers and
zooms back out to the headset's own field of view.

**Tilt**, in the top corner, turns the head with the phone as well, as a window onto the room, and
the drag still turns it past where an arm will reach. It is off until tapped, since iOS hands a page
the phone's orientation only once a tap has asked for it.

| Option    | Default | What it does                                                                                                                                                                                                   |
| --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buttons` | none    | The app's desk keys, as a row of buttons along the bottom: `{ label, code, hold }`. A touch sends `keydown` and `keyup` for `code`, the `KeyboardEvent.code`, at once, or with `hold` the `keyup` on the lift. |
| `pitch`   | `-0.45` | Where the head looks when the layer starts, in radians above the horizon. The default looks down at a table in front of the player.                                                                            |

The buttons go through the desk's own keys rather than calling into the app, so a touch does what
the key does. An app whose every control is a panel or a thing in the scene passes none.

The touch layer imports three.js, which splits three's core into a chunk of its own,
`three.core-<hash>.js`, shared with the scene's chunk, and `justdom-three/limits`, which lands in a
small `limits-<hash>.js` chunk the same way. A service worker that precaches the app should leave
all three out with the emulator's: `minesweeper` and `todo` add `"**/touch-*.js"`,
`"**/three.core-*.js"` and `"**/limits-*.js"` to their `globIgnores`.

## `justdom-xr/offer`

```ts
import { offerHeadset } from "justdom-xr/offer";

offerHeadset(() => import("./xr"), { touch: { pitch: -0.15 } }).then((xr) =>
  xr?.offerXR(board, menu),
);
```

`offerHeadset(scene, options)` offers the page a headset if it can have one. It first installs the
emulated headset the address asks for, with `installEmulator(options)`, `options.touch` being
`installTouch`'s options. Passing `touch` at all says the app's controls work on a phone. The
address picks the flavour (`emulatorFor(query, { touch, coarse })` is the rule on its own):

| Address           | Laptop                      | Phone (`(pointer: coarse)`) |
| ----------------- | --------------------------- | --------------------------- |
| `?emulator`       | IWER's panels               | the touch layer, if `touch` |
| `?emulator=devui` | IWER's panels               | IWER's panels               |
| `?emulator=bare`  | no panels                   | no panels                   |
| `?touch`          | the touch layer, if `touch` | the touch layer, if `touch` |

An app that passes no `touch` gets IWER's panels for `?emulator` on a phone too, and ignores
`?touch`, since its controls have not been tried on a phone. Then `offerHeadset` asks
`canPresent()`, and only then calls `scene`, a dynamic import of the module that makes the renderer
and the scene, and resolves to that module, or to null on a platform that cannot present. Nothing
here imports three.js, so on a laptop the page is the page and the scene's chunk, with three.js in
it, is never fetched.

If the emulator's chunk, the touch layer's or the scene's cannot be fetched because the page came
from a service worker's precache and a deploy has replaced the chunks it names, the page reloads
once a newer worker has taken it over, and at once if one already has. A page whose worker has not
been replaced has no newer page to reload into, so it waits rather than loops. Minesweeper, Euclid,
Knights and the todo app offer their sessions this way.

A page that offers its session another way, through `justdom-three`'s own Enter button, calls
`installEmulator(options)` before it renders, so `navigator.xr` is the emulator's by the time
three.js asks. It resolves once the headset is in, logs a chunk it could not fetch rather than
throwing, and reloads into a new deploy as `offerHeadset` does. Castle, the showcase and the desk do
this, each with `touch`.

## `justdom-xr/scene`

What the scene of a headset app repeats. It imports three.js and `justdom-three`, so import it from
the module that makes the scene, never from the page's entry.

- `Backdrop(color)` is a sphere of one colour round the viewer, shown while `backdropShown()` says
  so. In an `alpha-blend` session three clears the frame to transparent whatever `scene.background`
  says, so that the passthrough shows; the sphere is a background three has no rule about. It is
  drawn first and takes no part in the depth test. A scene sets its `background` to the same colour
  for a VR session, where three honours it.
- `inputModels(profiles?)` returns `createControllerModel` and `createHandModel` for `render()`'s
  options. Both read the WebXR input profiles when a controller or hand connects. With no argument
  they read them from three's default, the jsDelivr CDN, so a headset with no network draws neither.
  `profiles` names a copy of `@webxr-input-profiles/assets`' `dist/profiles` that the app serves
  itself, such as `` `${import.meta.env.BASE_URL}profiles` ``, resolved against the page's address;
  a service worker that precaches its `.glb` and `.json` files lets an offline headset draw them.
- `clientRect(element)` is the element's client rect, read again whenever the element is resized:
  called inside a panel's `effects`, it runs them again on each resize. A scale worked out from it
  follows the element when the window is resized during a session, rather than keeping the one it
  had as the session started.

```ts
import { effects } from "justdom-signal";
import { dom } from "justdom-three";
import { clientRect } from "justdom-xr/scene";

dom(ctx, board, [
  effects((o) => {
    const { width, height } = clientRect(board);
    o.scale.setScalar(boardScale(width, height));
  }),
]);
```

## `justdom-xr/theming`

```ts
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";

const query = new URLSearchParams(location.search);
followThemingQuery(query);
followOutlinesQuery(query);
```

`followThemingQuery(query)` turns on `justdom-three`'s `enableThemingMode()` when the query has
`?theming`, and returns what turns it off again, or null when the query did not ask. The panels then
follow rules edited, added or switched off in the browser's developer tools, which they otherwise
miss; [Theming mode](./three/tooling#theming-mode) says what it reads and what that costs. The apps
never turn it off, so it stays on for the life of the page.

`followOutlinesQuery(query)` is the same switch for `enableOutlinesMode()` and `?outlines`: every
panel outlines the elements that change, and the ones the mirror measures again for nothing.
[Outlines](./three/tooling#outlines) says how to read them.

This entry imports `justdom-three`, so import it only from a module that already does.

## `justdom-xr/session`

- `canPresent()` resolves to whether the platform can open an `immersive-ar` or `immersive-vr`
  session. Ask it before making a scene, a renderer or an Enter button, and after installing the
  emulator, which is what answers it in a desktop browser.
- `xrSession` is a signal holding the session the page is shown in, or null. The scene writes it,
  through `enterSession(getXRSession(ctx))` or `xrSession.set`, and the page reads it, since a page
  is mounted before there is a renderer to ask.
- `enterSession(session)` records a session starting or ending, and turns the passthrough off with
  it: every session starts in a room of its own.
- `passthrough` is the switch, `canPassThrough()` says whether the session can show the room and
  hide it again (only an `alpha-blend` one), and `backdropShown()` says whether an opaque backdrop
  should stand round the viewer: in a session, unless the room has been asked for and can be had.

The signals are module state, one set per page.

## `justdom-xr/driver`

What an app's `tests/xr-check.mjs` imports to drive a session on the emulated headset from Node,
through the device `install` leaves on `window.xrDevice`:

| Export                                         | What it does                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch({ args })`                             | Chromium on SwiftShader, which is what draws a session with no GPU. `args` adds flags a check needs on top, such as a Blink feature.               |
| `frames(page, n)`                              | Waits for the page to draw `n` frames.                                                                                                             |
| `observeThree(page)`                           | Keeps the scenes and renderers three makes in `window.threeScenes` and `window.threeRenderers`.                                                    |
| `headPosition(page)`                           | The origin of the `local` space.                                                                                                                   |
| `aimAt(page, head, target)`                    | Points the right controller's ray through a point, while the left one stays turned away as `install` left it.                                      |
| `rotate(v, pitch, yaw)`                        | Turns a point on a panel into the scene by the panel's angles.                                                                                     |
| `press(page, button)`                          | Presses `"trigger"` or `"squeeze"`.                                                                                                                |
| `hold(page, button, 1 \| 0)`                   | Closes or opens a button, for a drag.                                                                                                              |
| `check(ok, what)`, `finish()`, `closeAll(...)` | The tally, the exit code and the teardown.                                                                                                         |
| `precache(build, root)`                        | Builds an app with its own Vite and says which chunks its service worker precaches and which the page loads, for a check that holds the two equal. |

It is in `driver/` rather than `src/`, since it runs in Node and never in a page. It imports
`playwright-core`, an optional peer dependency, so a project that runs a check installs it beside
`justdom-xr`. It launches the Chromium at `/opt/pw-browsers/chromium-1194`, or the one `CHROMIUM`
names. Minesweeper's, the desk's, Euclid's and Knights' checks use it, by hand.

## Tests

`npm test` in the package, or `rush build --to justdom-xr`, runs `node --test` over `src`: the
session's rules, `canPresent` against a stubbed `navigator.xr`, the offer against a stubbed
platform, service worker and emulator, the touch layer's look, tap, hold, drag, long press and
buttons against a stand-in headset under jsdom, the controller and hand models' addresses against a
stubbed `fetch`, `clientRect` against a stand-in `ResizeObserver`, the clear-state shadow against a
stand-in WebGL context, and which queries `followThemingQuery` and `followOutlinesQuery` take.
`install` itself needs a browser, and is exercised by the apps' own check scripts, as is the driver.
Minesweeper's also plays a session through `?touch`, with a long press, a tap and a tap on the ×.
