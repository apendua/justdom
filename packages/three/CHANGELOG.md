# Change Log - @apendua/freedom

This log was last generated on Thu, 06 Aug 2026 07:34:16 GMT and should not be manually modified.

## 0.5.1
Thu, 06 Aug 2026 07:34:16 GMT

### Patches

- Built with TypeScript 7. VisualProperties declared its initialisation guard as 'asserts this is {#properties: ...}', which is not valid TypeScript -- a private name cannot appear in a type literal -- and TypeScript 7 rejects it. Replaced with a private #props getter applying the same guard. No behaviour change.

## 0.5.0
Wed, 05 Aug 2026 21:59:09 GMT

### Minor changes

- makeInteractive now accepts an optional `enabled` argument -- a boolean, a reactive getter, or an observable -- that turns raycast registration on and off while the entity stays in the scene. Omitting it keeps the previous always-interactive behaviour.
- Projected DOM elements now follow `cursor: pointer` as the stylesheet changes it, instead of deciding once whether they are ray targets. A button that becomes disabled stops being pointable, and stops carrying the handlers that would otherwise fire on events bubbling up from its children.
- The ray each controller draws is now cut at whatever it is pointing at, so it stops at the surface instead of disappearing into it, and stretches back out to a fixed reach when the hand is pointing at nothing. It used to be drawn at a fixed length regardless.

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

