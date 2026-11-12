# Change Log - justdom-xr

This log was last generated on Thu, 12 Nov 2026 13:53:02 GMT and should not be manually modified.

## 0.6.1
Thu, 12 Nov 2026 13:53:02 GMT

_Version update only_

## 0.6.0
Wed, 11 Nov 2026 23:41:15 GMT

### Minor changes

- The three peer range is now >=0.185.0 <0.188.0: CI tests both ends, and three before 0.185 fails the SVG plugin's fill rule
- Add sessionCanvas(renderer) and whilePresenting(ctx, render) to justdom-xr/scene, the session setup every headset demo repeated

## 0.5.0
Tue, 10 Nov 2026 21:23:39 GMT

### Minor changes

- justdom-three and justdom-signal are now peer dependencies rather than dependencies, so an app and justdom-xr share one copy of each. Apps must install both, as the README already said.

### Patches

- Other justdom packages are now required with a caret range (^x.y.z) rather than an exact version, in dependencies and peerDependencies alike.

## 0.4.1
Tue, 10 Nov 2026 20:13:58 GMT

_Version update only_

## 0.4.0
Mon, 09 Nov 2026 22:53:55 GMT

### Minor changes

- The touch layer has an Exit button, since it covers the page's own, and buzzes the phone when a finger becomes a hold.
- justdom-xr/touch: two fingers pinch the view in and out, by narrowing the emulated headset's field of view between 20 degrees (MIN_FOVY) and its own; the session's end zooms back out.
- Touch layer: a long press no longer selects the page or opens a context menu; the layer cancels the browser's own long press.
- `?emulator` installs the touch layer on a phone for an app that passes `touch` (`?emulator=devui` keeps IWER's panels), and `installEmulator` and `emulatorFor` from `justdom-xr/offer` install the emulator for a page that offers its session another way
- The touch layer's pinch zooms as the page's pointer does (twice the spread draws the view twice as large), and it takes `HOLD_MS`, `SLOP_PX`, `PITCH_LIMIT` and `MIN_FOVY` from `justdom-three/limits` instead of keeping its own copies, and re-exports them
- A finger held still on the touch layer and then moved drags with the trigger from where it landed, so panel rows, cards and `drag()` things can be dragged on a phone; held and lifted without moving it presses the grip, as the hold did before
- Add justdom-xr/touch: a phone's touch layer over the emulated headset (look, tap, and a 400 ms still press that holds the grip), installed by offerHeadset behind ?touch for an app that passes { touch }. The touch chunk imports three.js, which splits out a three.core chunk; a precaching service worker should ignore touch-*.js and three.core-*.js.

## 0.3.0
Thu, 05 Nov 2026 23:28:58 GMT

### Minor changes

- `launch({ args })` in `justdom-xr/driver` passes extra flags to Chromium, such as a Blink feature a check needs

## 0.2.0
Wed, 04 Nov 2026 20:25:47 GMT

### Minor changes

- inputModels() takes an optional path to the app's own copy of the WebXR input profiles, so a headset can draw controllers and hands without the CDN

## 0.1.2
Tue, 03 Nov 2026 22:19:23 GMT

### Patches

- The driver imports playwright-core as an optional peer dependency, so it runs outside the justdom repository

## 0.1.1
Mon, 02 Nov 2026 22:24:26 GMT

### Patches

- The README is a short overview that links to the guide and the API reference on justdom.dev, which now hold what it used to say; its stale claims about peer dependencies and old package names are fixed

