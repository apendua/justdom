# Headset sessions

A scene becomes a headset app with a button that asks for a session, and a few things every such app
repeats. [`justdom-three`](/api/three/rendering#entering-and-leaving-a-session) has the button;
[`justdom-xr`](/api/xr) has the rest: the emulated headset for a desk, the offer of a session to a
page that can have one, and the session as a signal the page can read.

## The button

`createXRButton(renderer, options)` builds the Enter AR or Enter VR button and sets the session up
the way the scenes here expect: it asks for `hand-tracking` and `local-floor` as optional features,
re-anchors the `local` origin to the first trustworthy viewer pose, asks the runtime for its fastest
frame rate, and installs a crash panel that writes an uncaught error onto the page where it can be
read on the headset. Each of those is an option that can be turned off.

```js
render(Scene).subscribe((renderer) => {
  document.body.appendChild(renderer.domElement);
  createXRButton(renderer).then((button) => document.body.appendChild(button));
});
```

It keeps three's ids and wording, so anything selecting `#ARButton` or `#VRButton` works unchanged,
and it is a button of this package's own rather than three's `ARButton` or `VRButton` because of
what those get wrong about recording the session, which the source of `button.js` says.

A control in the room ends the session with `end()` on the session itself:

```js
getXRSession(ctx)?.end();
```

## A headset on a desk

The emulator puts an emulated Quest 3 in an ordinary browser, drawn with IWER's panels for the
headset and the controllers. The demos install it behind `?emulator`, and only then, since it brings
over half a megabyte with it:

```js
const query = new URLSearchParams(location.search);
if (query.has("emulator")) {
  const { install } = await import("justdom-xr/emulator");
  install({ devUI: query.get("emulator") !== "bare" });
}
```

The [demos](/demos/) page links each headset demo that way. `install` also leaves the device on
`window.xrDevice`, which is how the apps' check scripts drive the headset and controllers in
headless Chromium through `justdom-xr/driver`.

## Offering a session to a page

An app that is a page first, and a headset app as something extra, should not load three.js for a
visitor on a laptop. `offerHeadset(scene)` installs the emulator if the query asks for it, asks the
platform whether it can present at all, and only then imports the module that makes the scene:

```js
import { offerHeadset } from "justdom-xr/offer";

just(root, [children(TodoApp({}))]).subscribe();
offerHeadset(() => import("./xr")).then((xr) => xr?.offerXR(root));
```

Nothing in `justdom-xr/offer` imports three.js, so on a laptop the page is the page and the scene's
chunk is never fetched. `render()`'s `presentingOnly` option is the other half of that bargain: the
scene draws nothing, runs no frame callback and pumps no panel until a session starts.

## What the page knows about the session

A page is mounted before there is a renderer to ask, so `justdom-xr/session` keeps the session as a
signal the scene writes and the page reads: `xrSession`, and `enterSession(session)` to record a
session starting or ending. A × on a card that ends the session, shown only while there is one,
reads it like any other signal:

```js
import { xrSession } from "justdom-xr/session";

$("button", [
  set({
    get hidden() {
      return xrSession.get() === null;
    },
  }),
  on("click", () => xrSession.get()?.end()),
]);
```

The scene writes it from `getXRSession(ctx)` inside an effect, which re-runs as a session starts and
ends. `canPresent()` says whether the platform can open a session at all, `passthrough` and
`canPassThrough()` are the switch for showing the room behind an AR scene, and `backdropShown()`
says when an opaque backdrop should stand round the viewer.

## What a scene draws round the panels

`justdom-xr/scene` has the parts a headset scene repeats: `Backdrop(color)`, a sphere of one colour
round the viewer for an AR session, where three clears the frame to transparent whatever
`scene.background` says; `inputModels()`, the controller and hand models for `render()`'s options,
loaded from three's default CDN when a controller connects; and `clientRect(element)`, an element's
rect read again when it is resized, for a panel whose scale follows the page's layout. This entry
imports three.js, so import it from the module that makes the scene, never from the page's entry.
