# Change Log - @apendua/freedom

This log was last generated on Fri, 07 Aug 2026 15:07:17 GMT and should not be manually modified.

## 0.7.1
Fri, 07 Aug 2026 15:07:17 GMT

### Patches

- `layoutEffects` now waits for the object to reach a scene once, and stays put when it is later re-parented. It used to re-run on every `added`/`removed` along the ancestor chain, so picking up anything an effect's object hung off — a board, a tray — tore the effect down and built it again over the detached instant in the middle of `Object3D.attach`. Nothing an effect can read has changed across a re-parent, since `attach` keeps the object where it was in the room; for a physics body it meant the whole simulation being rebuilt, and every marble losing the speed it had.

## 0.7.0
Fri, 07 Aug 2026 07:20:41 GMT

### Minor changes

- New `dropdown(props)`: a select built out of ordinary elements, so that it works in a portal, where a native `<select>` cannot — `<option>` has no CSS box to mirror and the list the browser pops up is chrome rather than DOM. Structure only; every part is dressed in a class name the caller supplies. `options` may be a getter, so an open menu follows a list that changes under it. Moved here out of `apps/euclid-xr`, which now uses it.
- `@apendua/justdom` is now a peer dependency. It was already what `dom(ctx, ...)` expects to be handed, and building `dropdown` out of it makes the dependency a real one rather than one carried in types alone.

### Patches

- Read computed CSS colours as sRGB, so panels are drawn in the colours they were written in
- Draw nothing for a border of no width, instead of filling a rounded element with slivers in the border colour

## 0.6.0
Thu, 06 Aug 2026 12:02:12 GMT

### Minor changes

- Portals can hold a layer above the panel. An element that is positioned with a positive z-index is pushed clear of what it covers, drawn in a render-order band above everything below it, and made opaque to rays by a blocker of its own -- so a dropdown menu is not something a ray can pass through into the buttons behind it. Fully transparent fills no longer write depth, and the portal asks for the rays to be cast again when it mirrors a change, so a menu opening under a resting ray is noticed. The portal's own background blocker now reports its click to the DOM, which is what dismiss-on-outside-click needs, and is two-sided -- being one-sided behind the container's half-turn flip, it was never raycast at all, so panels were not in fact opaque to rays.
- Adds getPortalRoot(node), which finds the panel a projected node belongs to, and marks each portal container with data-xr-portal so it can. A component inside a portal that wants to hear "clicked elsewhere" has to scope that to its panel: a document listener also hears real mouse clicks on the page around the scene -- the VR button, or an emulator whose every control is a mouse click -- and closes itself the moment you reach for the control that was going to drive the ray.

### Patches

- A press and a release are matched by the interactive object they landed on rather than by the mesh the ray happened to meet. A projected button is a background quad plus a quad of text, so a hand drifting a few millimetres from the label onto the background between pressing and letting go was counted as a miss and the click was dropped -- most visible on a wide row with a short label, such as an option in a dropdown menu. Squeeze is matched the same way.

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

