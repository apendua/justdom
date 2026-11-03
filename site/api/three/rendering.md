# Rendering and sessions

`render()` owns the renderer, the scene, the camera and the WebXR session. The tree it is given
reads them through the context it hands down, and `createXRButton()` builds the button that starts a
session. The [guide](/guide/rendering-a-scene) shows the shape of a scene; this page lists every
option.

## Rendering

`render(fn, options)` owns the `WebGLRenderer`, the scene, the camera, resize handling, and — when
the device supports it — the WebXR session lifecycle. The tree it is given decorates that scene
rather than producing one. `getCamera(ctx)`, `getScene(ctx)`, `getXRSession(ctx)`, `size(ctx)`,
`controllers(ctx)` and `useFrame(ctx, fn)` read from the context it hands the tree, through the
`createProperty` context mechanism the rest of this monorepo's stack shares.

| Option                  | Default                                         | What it does                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `antialias`             | `true`                                          | The renderer's antialiasing.                                                                                                                                                                                                                              |
| `foveation`             | `0`                                             | Fixed foveation for the headset's layer, 0 to 1.                                                                                                                                                                                                          |
| `presentingOnly`        | `false`                                         | Draw, run `useFrame` and pump portals only while a session is presenting. For a page with a flat interface of its own.                                                                                                                                    |
| `portalBudget`          | three tenths of a frame, clamped to 1.5 to 8 ms | Milliseconds of each frame every portal in the scene shares for mounting and settling content and taking closed panels down; a number or a getter read at the top of every frame. See [Loading, budget and updates](./panels#loading-budget-and-updates). |
| `portalPlugins`         | none                                            | Element plugins for every portal; `svgElements()` from `justdom-three/svg` is the one so far. See [Element plugins](./panels#element-plugins).                                                                                                            |
| `panelOptions`          | none                                            | What every panel starts from. See [Panel defaults](./panels#panel-defaults).                                                                                                                                                                              |
| `createControllerModel` | none                                            | Something to draw on a controller's grip space.                                                                                                                                                                                                           |
| `createHandModel`       | none                                            | Something to draw on a tracked hand's space. See [Hands](./input#hands).                                                                                                                                                                                  |
| `onBeforeRender`        | none                                            | Called with the renderer before each draw.                                                                                                                                                                                                                |
| `onAfterRender`         | none                                            | Called with the renderer after each draw.                                                                                                                                                                                                                 |

`useFrame(ctx, fn)` runs `fn` once a frame, on the session's frame loop while one is presenting. Use
it rather than `requestAnimationFrame`: once a session has the display the page stops being rendered
and the page's own animation frames stop with it, so a `requestAnimationFrame` loop stands still.
Under an emulator the page is presenting _and_ still rendering, so both work there and the
difference only appears on a headset.

`RendererContext` is the property behind `useFrame` and the once-a-frame events below; it is
exported so a test can mount a scene without a renderer: `RendererContext.set(ctx, {})` is enough
for a frame callback to be registered and never called. `runFrame(renderer, time, frame)` runs one
frame for such a renderer — the renderer's frame stream, then every `useFrame` callback, as
`render()`'s loop does before the late callbacks and the draw — so a test can see a carry follow the
hand or a panel mount.

### Entering and leaving a session

`createXRButton(renderer, options)` builds the Enter AR / Enter VR button and sets the session up
the way the scenes here expect. It is the package's own button, `createSessionButton`, rather than
three's `ARButton` or `VRButton`: it keeps three's ids and wording, so anything selecting
`#ARButton` / `#VRButton` or reading the label works unchanged, records the session only
synchronously, and gives up the focus the click left on it once the session starts, so the first
`Enter` typed in the session does not press it and end the session. `button.js` says what three's
buttons get wrong.

| Option         | Default  | What it does                                                                                                                                                                                                                                                               |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ar`, `vr`     | none     | The `XRSessionInit` for each mode. `hand-tracking` and `local-floor` are added as optional features unless the options below say otherwise, and a VR session asks for the default features `xr.js` lists.                                                                  |
| `anchor`       | `true`   | Re-anchor the `local` origin to the first trustworthy viewer pose (`anchorToViewer`).                                                                                                                                                                                      |
| `frameRate`    | `"high"` | Ask the runtime for its fastest rate; `"mid"`, a number in Hz, or `false` to leave the default (`requestFrameRate`).                                                                                                                                                       |
| `offerSession` | `false`  | Let the browser offer the session from its own chrome, from a state of rest only.                                                                                                                                                                                          |
| `autoEnter`    | `false`  | Ask for the session as soon as the button is built, where the platform hands the page an activation to spend (an installed PWA on Horizon OS). The button is built and returned either way.                                                                                |
| `crashPanel`   | `true`   | A throw out of the frame loop, an uncaught exception or an unhandled rejection ends the session and writes the error, stack and all, onto the page, where it can be read on the headset. The panel's Copy button puts it on the clipboard, or selects it where it may not. |
| `handTracking` | `true`   | Ask for the `hand-tracking` feature. See [Hands](./input#hands).                                                                                                                                                                                                           |

**Ending a session from inside it.** The system menu ends a session, and so does `end()` on the
session itself, which is how a control in the room — a power button on a desk, the × on a menu card
— lets the player leave with a press rather than through the headset's own menu:

```js
getXRSession(ctx)?.end();
```

`getXRSession(ctx)` is reactive and null between sessions. A page mounted before there is a renderer
to ask reads the session from `xrSession` in `justdom-xr/session` instead, which the scene writes:
minesweeper, Euclid and Knights through `enterSession(getXRSession(ctx))`, the desk and the todo app
with `xrSession.set` in their `components/Scene.ts`. `apps/minesweeper`'s × and `apps/desk`'s power
button both call `end()` on the session that signal holds.

The parts of `createXRButton` are exported for an app that builds its own button:
`requestFrameRate(renderer, preference)`, `anchorToViewer(renderer)`, `installCrashPanel(renderer)`
with `CRASH_PANEL_ID`, `createUnsupportedButton(mode)` for a platform with no session to offer, and
`createSessionButton(renderer, { mode, init, offerSession, autoEnter })`. Such an app asks for
`local-floor` as an optional feature of its session, AR included, as `createXRButton` does:
`anchorToViewer` measures upright in it, and in a session without it the anchor falls back to
`local`, which IWER leaves tilted when a session is entered with the head tipped.
`suppressSessionOffers()` is for a page that mounts three's own buttons; `xr.js` says what hazard it
closes.
