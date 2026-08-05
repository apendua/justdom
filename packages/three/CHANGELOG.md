# Change Log - @apendua/freedom

This log was last generated on Wed, 05 Aug 2026 21:24:29 GMT and should not be manually modified.

## 0.4.0
Wed, 05 Aug 2026 21:24:29 GMT

### Minor changes

- The interaction manager now publishes where each controller's ray lands, read with pointers(ctx), and cursors(ctx, options) draws a widget there — a white ball by default, resizable with `scale`, recolourable with `color`, or replaced entirely by cloning an object passed as `object`.
- Controller rays are now cast at the end of the frame, after every animate() callback and with world matrices refreshed, instead of on the controller's own move event — the pose three.js writes there is not readable until matrices are flushed, so hits (and anything drawn at them) were a frame behind. Each controller also tracks its own pending-update flag, so two hands no longer race for one.

## 0.3.0
Wed, 05 Aug 2026 15:45:44 GMT

### Minor changes

- Portal hover styles now propagate (the computed-style cache no longer swallows invalidations of the live CSSStyleDeclaration), only elements with cursor: pointer become ray targets, and each portal registers a single invisible blocker plane so panels stay opaque to rays.

## 0.2.0
Tue, 04 Aug 2026 22:07:09 GMT

### Minor changes

- Add createXRButton(), which prefers immersive-ar but falls back to immersive-vr on headsets without passthrough.

### Patches

- Fix createXRButton() leaving the immersive-vr fallback at floor-level origin instead of the local space AR content is authored for.

## 0.1.1
Tue, 04 Aug 2026 21:29:33 GMT

_Initial release_

