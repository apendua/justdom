# Change Log - @apendua/freedom

This log was last generated on Thu, 13 Aug 2026 21:23:25 GMT and should not be manually modified.

## 0.12.0
Thu, 13 Aug 2026 21:23:25 GMT

### Minor changes

- Portal surfaces are drawn in a single pass, and the objects a portal draws now keep their own matrices. Three draws a two-sided transparent material twice -- back faces, then front -- so that a closed shape's far surface composites under its near one, and flips `material.needsUpdate` before each pass, which invalidates the material's program. A quad has no far surface, so every box, glyph and tick in a panel was being drawn twice and recomputing its program key and re-uploading its uniforms twice per frame, for a second pass that redrew exactly what the first did. Separately, three recomposes every object's local matrix from its position, quaternion and scale once per frame on the chance it moved, and does it twice over because world matrices are brought up to date once before rays are cast and again on the way into the draw -- work a mirrored DOM never needs, since a box is placed by an effect when its layout moves and by nothing else in between. Boxes, content groups, quads, text, the checkbox tick, blockers and the portal container now compose their own matrices through the new `place` and `placeAndScale` helpers, which are exported for scenes that want the same for their own static objects. An opt-out is only worth what the scene above it allows -- three marks a world matrix stale when an object recomposes its own, and every descendant then recomputes unconditionally, so a group left on three's defaults in front of a panel hands the whole panel back the work it just opted out of, and the constraint runs all the way to the scene root. Rather than ask that of apps, which cannot opt out objects they never created and cannot see the cost from where the decision is made, a portal declines the recompute at its own perimeter: it recomputes its own world matrix each pass and passes the recompute on only when that matrix actually came out different, so a panel that has not moved costs a matrix multiply and a panel that has moved costs what it always did. Measured on a static panel of 800 mirrored boxes, 48.4 ms a frame became 8.1 ms, drawing the same pixels -- zero differing, maximum channel delta zero.
- Rewrite the portal's invalidation core around fine-grained reactivity: cache.js's broadcast subject and per-listener heuristic filters become mirror.js, a per-portal reactive DOM mirror. Mutation flushes are ingested inside one signal batch(), deduplicated against oldValue, and routed to per-node signals; style and reflow invalidation chain per level instead of filtering per listener. Geometry is stored scroll-invariantly -- positions in the parent's content space, clip windows in their owner's border frame, text layout in content space -- and the scroll offset is applied as a scene-level translation of each box's content group, so a frame of scrolling reads no rects and measures no text however long the list is. Positioned elements anchor to their containing block through a cached measurement, so a menu anchored above a scroller holds still while its trigger scrolls away. Every measurement sits behind a value equality, so portal-wide re-layouts stop propagating at the first element that did not move.
- `dom(ctx, mountable$, operators, options)` takes a fourth argument, and `{ opaqueToRays: false }` in it leaves the panel drawn but with no blocker plane spanning it, so rays pass through to whatever is behind. That is for readouts rather than controls, and mainly for a head-locked overlay: one rides between the eye and the whole scene, so an opaque one is a plate the player's own pointer keeps landing on. Only the panel's background goes -- a `cursor: pointer` element inside is still a ray target. Panels that say nothing are opaque exactly as before.

### Patches

- A renderer now has its frames before anything asks for them. `frames(ctx)` used to throw when the renderer had no frame subject yet, and the subject was created just after the scene was subscribed — which is just after every portal in it was built, since a tree has to exist before there is anything to draw. A caller that asked too early was handed the documented fallback, the browser's own `requestAnimationFrame`, which is correct everywhere the page is being rendered and useless inside an immersive session, where the page gets no rendering opportunities and that clock never ticks. The subject is created on demand instead, and the loop picks up whichever one is already there.

## 0.11.0
Mon, 10 Aug 2026 22:34:42 GMT

### Minor changes

- `<input type="checkbox">` is now projected into a scene as a component of its own rather than as one more box, so the tick is drawn where the browser's own is chrome that never reaches the DOM. The box comes from the same CSS the rest of the panel is drawn from, the tick from the element's `color`; the ticked state is written back as `data-xr-checked`, so a style that follows `:checked` is re-read; and the control is a ray target without asking for one, unless it is disabled.
- Adds keyboard(props): a clickable board with a standard laptop layout, dressed in caller-supplied classes like dropdown. There is nothing to type into a panel with -- a headset has no keys, and the one the system offers belongs to the compositor rather than the DOM, so none of it reaches the scene. Presses are shaped like KeyboardEvent; shift and the chording modifiers are one-shot, since nobody chords on a board they have to point at, and caps lock is not. The tree is built once and never changes shape: a state change moves a class name and the text inside a key, because a changed tree would cost a re-measure of all seventy-seven boxes.

### Patches

- Animations and scroll now keep working inside an immersive session. Once the headset has the display the page behind it stops being rendered, and everything the browser does in its rendering step stops with it: the document timeline no longer advances, so CSS transitions and keyframe animations froze where they stood, and the `transitionrun`/`animationstart`/`transitionend` and `scroll` events — all dispatched from that step — never arrived, so nothing even reported that an animation had begun or that a dragged list had moved. A portal now notices when the document has stopped keeping up with the frames, finds animations by sweeping `getAnimations()` on each mutation instead of waiting for events, advances each running animation by the real time that passed, and has every scroll it performs itself — the drag gesture and the `scrollable` widget's arrows and track alike — announce that scroll, which the portal's listener cannot tell from the real thing. The check is the condition itself — has the document timeline moved between two moments of real time — rather than whether a session is presenting, so it stays correct under an emulator, where the page is presenting and rendering both.
- An element no longer flashes at the size it had while it was transformed. A client rect measured under a CSS transform is the transformed bounds, and nothing reads it while the transform is there — the box carries the matrix itself and takes its size from layout offsets. The moment a transition returned the transform to `none`, that cached number became the element's size again: a card that spent its transition rotated five degrees was drawn about a tenth too wide, along with everything inside it, for the few frames until some unrelated mutation happened to re-measure. Nothing was going to invalidate it, either — a transition restyles without relaying out, which is exactly the case rect invalidation ignores in order to keep an animating transform free. The rect cache now depends on whether the element is transformed, so a crossing in either direction re-measures and the frames in between still cost nothing.
- Text is rasterized a line at a time rather than a character at a time when there is no letter- or word-spacing to apply, which is nearly always. Drawing glyph by glyph cost two canvas operations per character — a measure and a fill — so relabelling a 46-row list took 886 draw calls where it now takes 56. It also comes out kerned, which glyph-by-glyph drawing cannot be: the line now matches the width the browser measured instead of running a shade wide and having the texture grown to fit it.

## 0.10.1
Mon, 10 Aug 2026 07:14:43 GMT

### Patches

- The interaction manager's raycast honors visible: a subtree culled out of the draw is out of the cast, so a registered scroller no longer pays a ray test per hidden row per controller per frame — the cast is flat in list length. And scrollable() mounts its bar on a gated boolean rather than on the live metrics, so a frame of scrolling updates the thumb's styles and moves no nodes; profiled end to end, the scrollbar used to be unmounted and remounted on every scrolled frame, each remount answered with a portal-wide re-measure, which was most of what dragging a list cost inside a real browser.

## 0.10.0
Sat, 08 Aug 2026 14:20:52 GMT

### Minor changes

- `<img>` elements are mirrored into the scene. The picture is a layer on the same signed-distance quad that already draws the element's background and border ring — painted between them and the element's descendants, which is where CSS paints replaced content — so it costs no extra mesh and inherits everything the box already had: an avatar with `border-radius: 50%` comes out round rather than square behind a round frame, and a picture halfway out of a scroller is trimmed by the clip box that was going to trim its box anyway. `object-fit` (all five values) and `object-position` are resolved on the CPU into two rectangles, where the picture goes and what crops it, so a resize or a crop is a uniform write; a translucent PNG composites over the element's own background. It is not free for panels that draw no pictures: `div.js` reaches for the image module unconditionally, so the code ships with any app that projects DOM at all. Measured against two of them, `apps/todo-xr` and `apps/rubik`, it is the same 4,942 bytes minified in both — about 1.7 KB more over the wire once gzipped, and roughly 8% of the library — because it is a fixed cost of the library rather than anything that scales with the app.
- Textures are shared by URL and reference-counted: a list of a hundred rows wearing the same icon decodes and uploads it once, and the last element to let go of one disposes it. The URL is re-read when the element announces its own `load`, so swapping `src` swaps the picture and a `srcset` is followed as soon as the browser has resolved it — `src` never had to join the portal's attribute filter. A picture that fails to load draws nothing, leaving the element's own box behind it.
- A portal now hears an image arriving, under a `load` mutation type. Nothing is mutated and nothing restyled when a picture lands, so no observer reports it, but an `<img>` the author gave no size to has just been handed the one the picture turned out to have, and everything after it in the flow has moved — the same shape of event as a font arriving, and scoped portal-wide for the same reason.

### Patches

- Fixed a hairline hole through the middle of large boxes. Every edge in the rect shader becomes coverage through a smoothstep one derivative wide, and a distance to a box has a ridge down its middle where the nearest edge changes — along which `fwidth` reads zero, `smoothstep(0.0, 0.0, x)` divides by zero, and the driver is entitled to answer anything. It was invisible until something was big enough and square enough to the viewer to put a pixel row exactly on the ridge, which a picture in a panel facing you turned out to be. The width now has a floor of a ten-thousandth of a pixel.
- Images announce their arrival to the portal once per frame rather than once each. A picture landing re-measures the whole portal — an `<img>` given no size takes the one the picture turned out to have, and everything after it in the flow moves — which makes each arrival as expensive as a font's, and unlike fonts they arrive one at a time: a panel of nine icons was reflowing everything nine times over for a layout that settles once, and now does it once. The frame comes from the requester the animation clock already uses, and is given back the moment it fires, so a portal with nothing to announce asks for no frames at all.
- Fixed a listener that threw where `Element` is not a global. The portal's `load` listener guarded on `event.target instanceof Element`, which is the one thing `cache.js` warns against and the only place in the package that did it — and a reference error inside an event listener goes nowhere, so the announcement simply never happened rather than failing loudly. It reads `nodeType` now, like everything else in the file.

## 0.9.0
Fri, 07 Aug 2026 22:12:45 GMT

### Minor changes

- Portals honour 'overflow: hidden'. An element's clipping ancestors are intersected into one rounded box in its own px and handed to the box shader as uniforms, so the clipped edge comes out of the same distance field the box is already drawn with — antialiased, and rounded where the window is. The box also trims ray hits on partly clipped elements and drops wholly clipped ones from the raycast set and the render traversal. A scroll on the mirrored tree is announced as a reflow of the scroller's subtree, so setting scrollTop scrolls the panel in the scene.
- Adds scrollable(props): a scrolling window with controls, dressed in caller-supplied classes like dropdown. Arrows move a step and repeat while held, the free track jumps a window, and the thumb reports position and proportion. Presses rather than clicks, because a ray's click only arrives when the trigger comes back up.
- Scrolling lists can be dragged with the controller ray: hold the trigger over a list with more in it than fits and pull, and the content follows the hand; release while moving and it glides to a stop. The drag is sampled by projecting the ray onto the scroller's own plane each frame, so an angled, scaled or hand-held panel needs no special case and the list keeps up with a hand that has slid off it. A travel threshold separates a drag from a press, and a drag swallows the click on the row it grabbed — the touchscreen bargain. Nothing to opt into: any element that clips its overflow and overflows becomes draggable, and stops being so when it fits again.
- Positioned elements are clipped by their containing block rather than by every overflow ancestor: an absolutely positioned box escapes scrollers below its containing block — which is how a dropdown menu anchored outside a list survives its trigger row scrolling — and a fixed one escapes them all, exactly as on the page.

### Patches

- Scrolling no longer re-measures text. Every number a text measurement reports is relative to something that scrolls with the text — its position to the parent's border box, its line boxes to their own union — so a scroller sliding its content cannot change any of them, and the Range measurement that proved it each frame was the most expensive read in the layout cache. A scroll frame over a list now costs three client-rect reads per row and no text measurement, where it cost five and two; the saving grows with the length of the list, since a row scrolled out of sight was measured just like a visible one. Text whose own parent is the element that scrolled still measures: there the border box is the window standing still while the text moves inside it.

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

