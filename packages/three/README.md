# @apendua/freedom

A reactive Three.js scene graph, built on [`@apendua/signal`](../signal) with
the same operator vocabulary as [`@apendua/justdom`](../justdom) — `$`, `set`,
`children`, `effects`, `on` — except targeting `THREE.Object3D` instead of DOM
nodes. No VDOM, no diffing: every reactive value is wired directly to a
Three.js mutation through an RxJS subscription.

## Installation

```
npm install @apendua/freedom @apendua/signal three
```

`three` is a peer dependency.

## Usage

```js
import * as THREE from "three";
import { render, $, children, animate } from "@apendua/freedom";
import { component, just, effects, use } from "@apendua/signal";

const Scene = component((ctx) => {
  return just(new THREE.Scene()).pipe(
    children(
      $(new THREE.AmbientLight(0xffffff, 1)),
      $(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), [
        effects((cube) => {
          use(
            animate(ctx, () => {
              cube.rotation.y += 0.01;
            }),
          );
        }),
      ]),
    ),
  );
});

render(Scene).subscribe((renderer) => {
  document.body.appendChild(renderer.domElement);
});
```

`render(fn, options)` owns the `WebGLRenderer`, camera, resize handling, and
— when the device supports it — the WebXR session lifecycle. `camera(ctx)`,
`session(ctx)`, and `animate(ctx, fn)` read from that same context, using the
`createProperty`-based context mechanism shared with the rest of this
monorepo's stack.

## Pointing at things

`interactions(ctx)` gives an object the `makeInteractive()` operator, which puts
it in the raycast set and gets it pointer, select and squeeze events. It takes
an optional argument saying whether the object is pointable right now — a
boolean, a reactive getter, or an observable — so a ghost, a disabled control,
or anything else that comes and goes can leave and rejoin the raycast set
without leaving the scene:

```js
$(new THREE.Mesh(), [makeInteractive(() => props.draggable)]);
```

The manager raycasts once per controller per update to route those events, and
publishes the result:

```js
import { cursors, pointers } from "@apendua/freedom";

children(
  cursors(ctx), // a white ball, 1 cm across, on every ray hit
  cursors(ctx, { scale: 2, color: "#ff0000" }), // bigger, red
  cursors(ctx, { object: myArrow }), // one clone of your own object per hand
);
```

`cursors(ctx, options)` is the widget every XR scene ends up wanting: a mark
where the ray meets the scene, so the player can see what they are about to act
on. One appears per hand that is pointing at something interactive and goes away
with the hit. `object` is cloned rather than added, so its geometry and
materials are shared between hands; `scale` multiplies whatever scale it already
carries.

The ray each controller draws is cut at the same hit, so it stops at the
surface instead of disappearing into it, and stretches back out to a fixed
reach when the hand is pointing at nothing.

Hits are worked out once per frame, after every `animate(ctx, fn)` callback has
run and with world matrices already refreshed — the last thing before the frame
is drawn. That is what keeps the widget on the ray: cast any earlier and it
lands where the hand was pointing, and what it was pointing at, one frame ago.

`pointers(ctx)` is the data behind it — a reactive map from target ray space to
a signal holding that controller's current `THREE.Intersection`, for scenes that
want to do something else with the hit (a snapping preview, a measurement, a
sound).

## Projecting DOM into the scene

`dom(ctx, mountable$, operators)` mounts a
[`@apendua/justdom`](../justdom) component tree onto a Three.js `Group` through a
portal, so ordinary DOM-based UI (menus, HUDs, forms) can be composited
directly into a 3D or WebXR scene and still receive pointer events routed
through `interactions(ctx)`.

Two things about a portal are worth knowing before writing UI for one.

**Sizes are re-measured when the tree changes, not when an attribute does.**
The hover handlers write `data-xr-*` back onto the element they fired on, so
re-measuring the panel on every attribute mutation would mean re-laying-out
the whole thing on every twitch of the ray. A class swap restyles and
repaints; the one thing it re-measures is the mutated element's own subtree,
which is what a toggled `transform` moves (see below) — nothing outside it.
So anything that changes *layout* — a menu opening, a section expanding —
has to be mounted and unmounted rather than hidden and shown.

**The panel's background is clickable, and it is the panel you should listen
to.** A ray that lands on the panel but on none of its buttons hits the blocker
spanning the container, which dispatches a bubbling `click` on the portal's
root element. That is what "clicked outside" means to a menu that wants to
close itself; there is no other way for the tree inside to learn it happened.

Listen for it on the panel rather than on the document, via
`getPortalRoot(node)`:

```js
const scope = getPortalRoot(root) ?? document;
scope.addEventListener("click", onClickElsewhere);
```

A `document` listener also hears every real mouse click on the page around the
scene — the VR button, and in development an emulator whose every control is a
mouse click. A menu listening there closes itself the moment you reach for the
control that was going to choose from it, which looks exactly like the ray
having no effect. `getPortalRoot` returns null off a portal, where `document`
is the right answer and there is nothing to disambiguate.

## Transforms

A CSS `transform` (with its `transform-origin`) is mirrored onto the
element's object as a matrix, not baked into its geometry — which is what
makes it the cheap way to move things: a `transform` written by a
`[data-xr-hover]` or `[data-xr-active]` rule becomes a matrix write, with no
re-layout and no re-rasterized text. Prefer it for motion, exactly as on the
flat web.

One print of the measuring tape to know about: a transformed element (and
everything under it) is measured off the layout — whole-pixel offsets —
rather than the subpixel client rects untransformed content enjoys, because
client rects come back with the transform already applied. Text is measured
with the transforms briefly switched off instead, so its line boxes and
positions are exact whatever the transform — including full 3D rotations.

## Animation

CSS transitions, keyframe animations and Web Animations play inside a
portal: while anything is animating, the affected elements are sampled once
per frame — through the same invalidation path a mutation takes — and the
moment nothing is, the sampling stops. An idle panel costs nothing.
Inline-style writes from a `requestAnimationFrame` loop work too; each one
is an ordinary mutation scoped to the element it touched.

The cost per frame is the flat web's own hierarchy, and the guidance is the
same one every web developer already knows. `transform` and `opacity` (and
colours) are the cheap tier: a style read and a matrix or material write per
animating element. Text is no exception — glyphs are rasterized once as a
mask and coloured by the material, so animating `color` re-draws nothing.
(The mask needs one colour: text with a `text-shadow`, or a decoration
explicitly coloured something other than the text, keeps its colours baked
into the texture and pays a re-draw per change.) Animating a *layout*
property — `height`, `padding`, `font-size` — re-measures the panel every
frame, because a growing element moves neighbours no one named. It works;
save it for moments, not idle loops.

## Layers

An element that is positioned and stacked above — `position` other than
`static` plus a positive `z-index`, the same declaration the flat build needs
anyway — becomes a layer of its own rather than one more nested box:

```css
.menu {
  position: absolute;
  z-index: 1;
  top: 100%;
}
```

It is pushed clear of the surface it covers, so the depth buffer and stereo
both agree that it floats; its whole subtree is drawn in a band above
everything below it, however shallow the overlay itself is; and it is opaque
to rays, through a blocker of its own. That last one is the part with no
counterpart on a flat screen: without it the ray that lands between two menu
rows carries straight through the menu and hits a panel button a few
millimetres behind — not a miss, a click on something the menu is covering.

Layers stack by nesting, not by how big the number is: a menu inside a modal
is two layers up, `z-index: 1000` is still one. Keep an overlay within the
silhouette of the panel it belongs to where you can, and keep it out of the
flow — a menu that grew the panel would re-center it, sliding the whole thing
out from under the ray that opened it.

A native `<select>` cannot work here, layers or not: `<option>` has no CSS box
to mirror, and the list the browser pops up is chrome rather than DOM, so none
of it reaches the scene. `dropdown(props)` is one built out of ordinary
elements instead:

```js
dropdown({
  options: () => outputs.get().map(({ id, name }) => ({ value: id, label: name })),
  selected: () => chosen.get(),
  onSelect: (value) => chosen.set(value),
  classes: { root, trigger, caret, menu, option, optionSelected },
  placeholder: "Choose…",
});
```

Only the structure is shared: every part is dressed in a class name the caller
supplies, because a panel's dropdown has to look like that panel. Two of those
classes carry the requirements above — `root` is the positioning context
(`position: relative`), and `menu` is the layer (`position: absolute;
z-index: 1`), with `top: 100%` or `bottom: 100%` deciding which way it opens.
The menu is mounted and unmounted rather than hidden, for the re-measuring
reason above, and it closes on a click anywhere else in the panel.

`options` may be a getter, for a list that changes under the player — devices
coming and going, a document being edited — and the open menu follows it.

## Real examples

This package drives several full apps in this monorepo —
[`apps/rubik`](../../apps/rubik), [`apps/blockout-xr`](../../apps/blockout-xr),
[`apps/marblerun`](../../apps/marblerun),
[`apps/todo-xr`](../../apps/todo-xr) — worth reading for realistic scenes
combining lighting, keyed lists (`list`/`keyedList`), controller/hand input,
and DOM panels projected into 3D space.
[`apps/showcase-xr`](../../apps/showcase-xr) is the animation sampler: three
panels demonstrating hover/press transitions, CSS keyframes, a Web Animations
API animation, a `requestAnimationFrame` loop writing inline styles, animated
text colour, static transforms, and a layout-tier width transition.

## License

MIT — see [LICENSE](../../LICENSE).
