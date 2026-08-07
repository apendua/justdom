# Change Log - @apendua/freedom

This log was last generated on Fri, 07 Aug 2026 21:07:43 GMT and should not be manually modified.

## 0.8.1
Fri, 07 Aug 2026 21:07:43 GMT

### Patches

- A text node's measured layout now reports the size of its line boxes rather than the client rectangle they were read from. The rectangle carried a viewport position that nothing downstream wanted, in a `DOMRect` — an instance of a class, which the selector proxy cannot look inside — so every re-measurement handed its dependents a new identity and re-rasterized the label's texture. Text that only moved, which is what a layout animation and a scroll both do to a whole subtree every frame, now re-measures without re-drawing anything.
- Wrapped text is measured by the line rather than by the character. A range already reports the line boxes the browser broke the text into; what it does not report is which characters landed on each one, and that used to be recovered by measuring every character in turn. Because a character can never land on an earlier line than the one before it, the offset each line starts at can be found by bisection instead — a handful of measurements per line, and one more per line for its own extent, which is also more faithful than a union of per-character boxes. In Chromium a wrapped paragraph measures in 0.055ms rather than 0.411ms, and a paragraph of Japanese in 0.100ms rather than 1.756ms; single-line labels keep the fast path they had. Every layout tried — wrapped, justified, centred, right-aligned, bidi, CJK, `pre`, `pre-wrap`, `pre-line`, `overflow-wrap: anywhere` — reports what it reported before.

## 0.8.0
Fri, 07 Aug 2026 17:18:23 GMT

### Minor changes

- Style invalidation is scoped to the mutation's neighbourhood instead of the whole portal: the observer's targets ride along with each batch, and a computed-style cache re-reads only when a change at some target's parent subtree can actually restyle it. A hover twitch went from O(panel) style snapshots to O(neighbourhood). `:has()` crossing upward past the mutated element's parent is a documented limitation.
- CSS `transform` and `transform-origin` — 2D and 3D alike — are mirrored onto the element's object as a matrix, fixing the mis-render where a transformed element drew as its transformed axis-aligned bounds; `translateZ`/`rotateY` move content into actual scene depth. Transformed elements are measured off layout offsets (client rects come back with the transform already applied); text is measured with the transforms briefly switched off, so line boxes and positions are exact under any transform. Attribute mutations now also re-measure the mutated element's own subtree, which is what a toggled transform moves.
- CSS transitions, keyframe animations, Web Animations and rAF-driven inline styles now play inside a portal. An animation clock samples the animating elements once per frame through the same invalidation path a mutation takes — style samples scoped to the animating elements, rect re-measures scoped to what the animated properties can actually move — and requests no frames at all while nothing animates. A `getAnimations()` sweep reconciles what events miss and refines keyframe classifications.
- Text color is tinted onto a glyph mask through the material instead of being baked into the rasterized texture, so animating `color` re-draws no canvas and uploads nothing. The mask rides in the material's alpha map — only coverage is sampled, so linear filtering has no transparent-black texels to drag into glyph edges as a dark fringe. Text with a `text-shadow`, or a decoration explicitly coloured something other than the text, keeps the baked path.
- Each box renders as one shared unit quad and a signed-distance shader — per-corner radii, per-side border widths and both colours as uniforms — replacing the background + border pair of triangulated meshes. Geometry is never rebuilt: a resize is a scale write, everything else a uniform write, which halves the mesh count per element and makes layout-class animation affordable. Corners are circular where CSS would draw elliptical ones for percentage radii on non-square boxes.

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

