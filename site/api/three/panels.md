# DOM panels

`dom()` puts ordinary DOM into the scene through a portal, and this page is everything about that
portal: how the panel is built, what a ray does to the page it shows, how it follows the page, how
its work is paced, and how it is typed into, moved and placed. [What a panel draws](./css) lists the
CSS it follows. The [guide](/guide/dom-panels) is the introduction.

## Projecting DOM into the scene

`dom(ctx, source, effects, options)` mounts a [`justdom`](../justdom) component tree, or mirrors an
element the page already has, onto a Three.js `Group` through a portal, so ordinary DOM-based UI
(menus, HUDs, forms) is composited into a 3D or WebXR scene and still receives pointer events routed
through `interactions(ctx)`. `source` is a `Mountable`, a subscribable of them, an element or a
subscribable of elements; each emission is a fresh portal with the previous one taken down.
`effects` go on the group, as for any `$()`. `createPortal(ctx, options)` is the same thing without
the group, for a scene that drives portals by hand.

It does that without depending on `justdom`. A `Mountable` — a tree that has not been put anywhere
yet, exposing one method that swaps it into a span of sibling nodes — is declared here rather than
imported, so `justdom` is not a peer dependency of this package. A justdom tree satisfies it,
because the two declarations are the same shape and TypeScript compares them structurally; so does
anything else that builds real DOM nodes and knows how to hand them over.

The options, each with the section that says what it does:

| Option             | Default     | What it does                                                                                                                         |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `root`             | none        | An element of the page to mirror where it stands. [Mirroring DOM the page already has](#mirroring-dom-the-page-already-has).         |
| `opaqueToRays`     | `true`      | Whether the panel's background stops rays. [The panel's background](#the-panel-s-background).                                        |
| `keyboard`         | the scene's | The keyboard its fields are typed with, or `false`. [Text fields and the keyboard](#text-fields-and-the-keyboard).                   |
| `thumbstickWheel`  | `false`     | The thumbstick as a mouse wheel on this panel. [What a ray sends the page](#what-a-ray-sends-the-page).                              |
| `haptics`          | the scene's | What the hand feels from the panel's controls, or `false`. [Haptics](#haptics).                                                      |
| `loadingFrame`     | the scene's | The frame shown while a long mount runs, or `false`. [Loading, budget and updates](#loading-budget-and-updates).                     |
| `onLoadingChanged` | none        | Told once, with `false`, when the initial mount lands. [Loading, budget and updates](#loading-budget-and-updates).                   |
| `budget`           | `5`         | Milliseconds per frame, only for a portal outside `render()`. [Loading, budget and updates](#loading-budget-and-updates).            |
| `priority`         | `0`         | This panel's say in the scene's shared budget. [Loading, budget and updates](#loading-budget-and-updates).                           |
| `atomic`           | `true`      | Whether an update lands whole. [Loading, budget and updates](#loading-budget-and-updates).                                           |
| `maxTextScale`     | `4`         | The ceiling on how finely this panel's text is rasterized. [How sharp the text comes out](#how-sharp-the-text-comes-out).            |
| `draggable`        | `false`     | Whether the player can move the panel, or a `PanelDragOptions`. [Letting the player move a panel](#letting-the-player-move-a-panel). |
| `plugins`          | none        | Element plugins for this panel alone, asked before the scene's. [Element plugins](#element-plugins).                                 |

`keyboard`, `loadingFrame`, `haptics`, `thumbstickWheel`, `maxTextScale`, `atomic`, `opaqueToRays`,
`priority` and `budget` can also be set for the whole scene; see [Panel defaults](#panel-defaults).

### What a ray sends the page

An element is a ray target of its own when its computed `cursor` is `pointer`, the signal a page
uses for "clickable", when it is `draggable="true"` (see
[Dragging and dropping](#dragging-and-dropping)), or when it is the `<label>` of a text field (see
[Text fields and the keyboard](#text-fields-and-the-keyboard)), and its `pointer-events` is not
`none`. Checkboxes and text fields are targets without asking. A clickable element built outside any
portal is a ray target and nothing more: each element a ray acts on registers with its panel's
forwarder, which listens on the portal's container object and reads which of its elements each ray
event went through (`createPanelForwarder` in `elements/pointerForwarding.js`), so the panel does
all of the below once, for every element in it.

**A press.** Closing the trigger on a target sends `pointerdown` and `mousedown`; opening it sends
`pointerup`, `mouseup` and `click`. The element carries `data-xr-hover` while a ray is on it and
`data-xr-active` while it is held, each hand's flags its own: a button two hands are on, or two
hands press, keeps each flag until the last of them leaves or lets go. Clickable elements nest, if
only because `cursor` is inherited: the innermost one is the target, its events are sent once and
bubble from there, and every clickable element around it takes both flags, as `:hover` and `:active`
would. An ancestor that is not a ray target takes neither.

**The grip** is the mouse's other button: a press of it, let go on the element it started on,
arrives as `contextmenu`, which is where a page already flags a tile or opens a menu of its own. Not
a grip that something above the panel took as it closed — a `drag()` with `squeeze` among its
`buttons` picking up what the panel hangs from — and not one closed while the trigger carries a row
or moves a list, gliding included, on any panel: a page in the middle of a drag hears no other
button. A trigger only resting on a row moves nothing yet, and a grip under it is a right-click. The
grip's start is the one ray event that goes on past the panel, so that a scene can pick up with the
grip what the panel hangs from; a grip nothing took is the panel's, and its end, completion and miss
stop at the panel as a press's do.

**The point.** Every event carries the point the ray met as `clientX` and `clientY`, mapped onto the
page's own layout, so a page that finds what was pressed from where it was pressed — a board drawn
as one `<svg>` path — reads the place a mouse over the same spot would have given it. A press, its
release, its click, a right-click, a press on a scrolling list and the ray's arrival on a control
(by the rule the hover pulse follows, see [Haptics](#haptics)) each read where the page lays the
panel out; a move, sent every frame, reads no layout and takes its point where the panel was last
read, so a hover starts exact and drifts only by what the page moves while the ray stays.

**Pointers.** A press, its release and a move each send, ahead of their mouse event, the pointer
event a browser sends ahead of it, at the same point, so a page written for pointers hears the ray
as well. They say `pointerType` `"mouse"`, but each hand is a pointer of its own, with a `pointerId`
from 2 on, since 1 is the mouse's, so a page that follows a drag by its pointer is not thrown when
the other hand's ray crosses the same element. Every event a hand sends carries the `buttons` it
holds, the trigger as 1 and the grip as 2.

One hand is the primary one, as a browser has a primary touch among several: the first hand whose
ray reaches a control while the primary one holds no button and points at no panel, or a hand whose
trigger closes while the primary one holds no button. Only its pointer events say `isPrimary`, and
only it sends `mousedown`, `mousemove`, `mouseup` and the mouse's enter and leave, so a page that
follows the mouse follows one hand and not two rays taking turns. When another hand takes over, the
mouse leaves what the first hand was over, on every panel, and is over what the new hand is over,
its captor if it holds a capture, before anything the new hand sends. A `click` and a `contextmenu`
go for either hand.

**Crossings.** As the ray moves from element to element, the page hears what a browser sends for a
mouse: `pointerout` and `pointerleave` from what the ray left and `pointerover` and `pointerenter`
on what it is on, then `mouseout`, `mouseleave`, `mouseover` and `mouseenter`, each naming the other
element as `relatedTarget`. The element a hand is over is the innermost control under its ray, with
the elements around it up to the panel's root; a ray that slides off the controls onto the panel's
background, or off the panel, leaves them all, at the point where the page last heard the pointer.
These hold still while the hand holds something draggable, as `:hover` does under a drag, and catch
up at the release.

**Cancels.** A page that cancels `pointerdown` hears no `mousedown`, `mousemove` or `mouseup` from
that hand until its trigger opens, and hears the `click` all the same. A press that becomes a scroll
or a drag and drop is taken from the page the way a browser takes one: the page hears
`pointercancel` where the press went, the pointer leaves what it was over on every panel, and
nothing more of that hand is sent, `pointerup` and `mouseup` included, until the trigger opens; then
the pointer and the mouse catch up with where the ray is, on every panel. A hand lost in the middle
of a press sends no release, and its pointer is cancelled the same way, the elements it held lose
`data-xr-active`, and the mouse leaves what the hand was over on every panel. `pointercancel` and
the leaves after it say where the page last heard the pointer: the last move or crossing before a
press became a scroll, and the press for a drag and drop, which `dragstart` says too. A release that
sends no `pointerup` catches the pointer and the mouse up where the ray is if it is on the panel,
and otherwise where the page last heard the pointer. The crossings that catch a panel up carry the
point where the ray crosses that panel, as a move does, and where the page last heard the pointer on
a panel the hand is over nothing on.

**Capture.** A browser knows nothing of the hands' pointers, so `setPointerCapture` with a hand's
`pointerId` would throw. Once a hand sends anything while a panel is up, the three capture methods
on `Element` are wrapped, and the last panel to go puts the browser's back. A capture the browser
refuses for a hand is kept here instead, starting before the hand's next event with
`gotpointercapture` on the captor. While it holds, the hand's moves and its release go to the
captor, and the pointer is over the captor and nothing else, as is `data-xr-hover`. The moves and
the release come from where the ray crosses the plane of the captor's panel, the moves once a frame
the ray has moved, wherever the ray is; a release whose ray crosses that plane nowhere says where
the pointer last was. The capture ends with `lostpointercapture` at the release, after its
`pointerup` and `mouseup`, at `releasePointerCapture`, when the press becomes a scroll or a drag and
drop, or when the hand is lost. `gotpointercapture` and `lostpointercapture` say where the page last
heard the pointer. Releasing a pointer that holds no capture does nothing, as for a pointer the
browser knows. The grip's `contextmenu` comes alone, as before.

**The wheel.** A panel with `thumbstickWheel: true` hears a hand's thumbstick as a mouse wheel, for
a page that zooms or pans on `wheel`:

```js
dom(ctx, drawing, [set({ position })], { thumbstickWheel: true });
```

While the hand's ray is on the panel and the hand holds no button, pushing the stick forward or
pulling it back sends `wheel` once a frame to the element under the ray: the innermost control the
ray is on, or, on a list's gaps or the panel's background, whatever element is there. A ray on an
object the scene hangs in the panel turns nothing, and on a panel with `opaqueToRays: false` only a
ray on a control or a list does. `deltaY` is in px (`deltaMode` 0) and negative for the stick pushed
forward, following how far the stick is pushed: nothing inside a small dead zone, 1000 px a second
at the stop. `clientX` and `clientY` are where the ray crosses the panel. Either hand turns it. The
wheel scrolls nothing of itself, since a list is scrolled by pulling it (see **Clipping and
scrolling**); a page that wants it to scroll one does that in its handler, with `scrollElementBy`.
It is off unless a panel asks, because a scene may read the stick for something else.

**In development**, a press that lands on an element of a panel's page with no ray target under it
warns once per element, naming the element. A press on the panel's empty root, or on an object of
the scene's own hung in the panel, is not one. Development is Vite's `import.meta.env.DEV`, or
`NODE_ENV` set to `development` where Vite is not used.

Followed:

- The browser's order and pairing of pointer and mouse events, their `buttons`, `pointerId`,
  `isPrimary` and `relatedTarget`, and `click` and `contextmenu` for either hand.
- `pointercancel` when a press becomes a scroll or a drag and drop, and for a hand that is lost,
  with the leaves a browser sends after it.
- Pointer capture per hand, kept beside the browser's, with `gotpointercapture` and
  `lostpointercapture`.
- The point on the page, exact for a press and a crossing, and where the panel was last read for a
  move.
- A scale on the mirrored root, or above it, in the mapping, so on a page scaled to fit its window
  the point is where the page draws that spot.

Not followed:

- The point is on screen only for a panel mirroring an element the page shows. A panel built from a
  tree lives in a container the portal parks off screen, so its points are right against the page's
  own rects but `document.elementFromPoint` and `caretPositionFromPoint` find nothing at them.
- A rotation, a skew, a flip or a perspective on the mirrored root's chain is left out of the point,
  as the mirror leaves it out (see
  [Mirroring DOM the page already has](#mirroring-dom-the-page-already-has)).
- The ray event stops at the panel, except the grip's start, so nothing outside the panel hears a
  press the panel took.
- `pointerType` is `"mouse"` for a hand, and a hand's pointer is unknown to the browser, so only the
  capture methods wrapped above take its `pointerId`.
- The wheel is the thumbstick alone, and `deltaX` is always 0.

### Mirroring DOM the page already has

A mountable is for a panel that exists only in the scene. An app that delivers a flat interface
first, and an immersive session as something extra, already has its DOM — laid out, styled, wired to
its state — and `dom()` mirrors it where it stands:

```js
const hud = document.getElementById("hud");

dom(ctx, hud, [set({ position })]);
```

Nothing about the element changes hands. It stays in the document with the styles the page gave it;
the portal watches it with the same observer it watches its own container with, so whatever the
element holds when the portal is built is the initial content and whatever the page does to it
afterwards is followed. A press on the mirrored button is a click dispatched on the real one, and
the flags the portal writes are taken off again with the portal. When the session ends the page is
as it was. The portal marks the element `data-xr-portal` while it watches.

- **The element is the panel's frame, and what is drawn is what is inside it.** Its border box is
  the panel's size — a panel centred on its origin, a centimetre a px — and it is what
  `getPortalRoot` finds and what the background click lands on, but its own background and border
  are not mirrored. A card wants to be the element's child, not the element:

  ```html
  <div id="hud">
    <div class="card">…</div>
  </div>
  ```

- **It has to be in the document**, and the portal refuses one that is not, one that is already a
  panel, one inside a panel and one with a panel inside it, since every walk the mirror makes climbs
  to the nearest panel top and stops. A portal built over such an element does not `mount()`: the
  page owns the content.
- **It has to stay laid out.** `display: none`, or taking the element out of the document, measures
  every box at nothing, and the panel is an empty frame with no error to say why. Hide the page's
  own view with `visibility: hidden`, which keeps the layout, or cover it — the todo app puts the
  renderer's canvas over the page for exactly as long as a session is presenting.
- **Neither it nor anything above it may be turned.** Every box inside the element is measured
  through its client rect, which the browser reports with every transform above the box applied,
  while the element itself is placed as though it had none. A scale is undone: a page that scales
  itself to fit the window, by a `transform` that only scales and translates or by the `scale`
  property, on the root or anywhere above it, is measured at its layout size. A rotation, a skew, a
  flip or a perspective cannot be divided out, so a root on a chain that carries one has every
  offset, size and baseline inside the panel slightly wrong, and the portal says so once, with a
  `console.warn` naming the root and the element that carries the transform. It looks at the next
  measurement after it claims the root, the window resizes, the document's stylesheets change, or
  the root's own attributes or a transition on it change, and at once when the ray presses or
  arrives on a control, so a transform that arrives after the claim is caught at the next of those.
  Mirror an untransformed wrapper and transform what is inside it, or take the transform off for as
  long as a session runs, which is what the desk app does. A `perspective` counts only above the
  root: one on the root itself projects what is inside the panel, which the mirror draws as real
  depth, so it is neither refused nor warned about.
- The CSS `zoom` property is not read: a root under a `zoom` is measured at its zoomed size, with no
  warning.

### What a panel follows

A box is drawn from its computed style: background colour, a gradient (see
[Gradients](./css#gradients)), a border width per side, `border-radius`, `opacity`, `visibility`,
`transform` (see [Transforms](./css#transforms)), `overflow` (see
[Clipping and scrolling](./css#clipping-and-scrolling)), and its place in the page's paint order
(see **Paint order**). Text is rasterized once as a mask and coloured by its material, so animating
`color` re-draws nothing; text with a `text-shadow`, or a decoration coloured other than the text,
keeps its colours baked into the texture and re-draws per change.

**A change to the DOM is followed as far as it can reach.** Every attribute is followed: a class, an
inline style, `hidden`, an app's own `data-*` or `aria-*` flag. Changing one restyles the element,
its subtree and its siblings (apart from the SVG geometry below), and re-measures the element's
subtree. Then the element and what comes after it in its parent re-measure where they are, every
item in the row when the parent is a flex row. The change climbs on to the parent's own siblings if
the parent changed size or is an inline box, and so on up to the panel, which resizes with what it
holds. So a menu opened by a class, or a section shown by taking `hidden` off, resizes the panel as
it would if it were mounted. A change that moved nothing costs a client rect for the element, for
each element after it and for the parent, a text measurement for each text node after it, and a
client rect for each positioned box in the panel.

Two changes stay cheaper. An inline `style` write that moves no box but the element's own
re-measures the element's subtree and nothing around it: a write of properties that move no box at
all — `transform`, `opacity`, a `visibility` other than `collapse`, the colours — and a write of the
offsets, sizes and margins, physical or logical, on an element positioned `absolute` or `fixed`. So
a gauge that writes `style.transform` every frame, and a scrollbar thumb that writes `top` and
`height` on every scroll, pay for re-measuring themselves alone. Changing `position` itself moves
what follows. Inside an `<svg>`, the attributes that place and size what it draws — `x`, `y`,
`width`, `height`, `x1`, `y1`, `x2`, `y2`, `cx`, `cy`, `r`, `rx`, `ry`, `d`, `points`, `dx`, `dy`,
`rotate` and `transform` — restyle the element and its subtree but not its siblings, since a shape
is placed in user space and moves none of the shapes beside it; on the `<svg>` root itself, `width`
and `height` size a box in the page and reach its siblings as any attribute does.

**Hover and press are presentational, by contract.** The four attributes the portal writes itself —
`data-xr-hover`, `data-xr-active`, `data-xr-checked` and `data-xr-focus` — restyle the panel but are
declared unable to move it. Colour, background, border colour, opacity and `transform` all work; a
width, a padding or a font size that changes under the ray is not mirrored, and the boxes stay the
size they were. Three of the four carry a second restriction: **`data-xr-hover`, `data-xr-active`
and `data-xr-focus` may only style the element they match and its subtree.**

```css
.row[data-xr-hover] {
  background: #1d4ed8;
} /* fine */
.row[data-xr-hover] .label {
  color: #fff;
} /* fine — descendant */
.row[data-xr-hover] ~ .row {
  opacity: 0.5;
} /* ignored — sibling */

input[data-xr-checked] + .label {
  text-decoration: line-through;
} /* fine — checked is not restricted */

.button[data-xr-hover] {
  transform: translateZ(4px) scale(1.04); /* fine — a matrix write */
  padding: 12px; /* ignored — this is layout */
}
```

These are the most frequent mutations a panel sees — one per element the ray crosses, three more on
a press — and how far a change may style is how far the portal must go looking; `mirror.js` says
what the contract saves and why `data-xr-checked` is left out of the second restriction.

**A row arriving costs the row.** A change to a child list can only change the verdict of the
positional selectors, and the mirror follows those exactly as far as CSS lets them look: forward
from the change — `~`, `+`, `:nth-child`, `:first-child` and their `-of-type` forms restyle the rows
after the arrival — and one element back, for `:last-child`, `:only-child` and the `-of-type` pair.
Inserting or removing in the middle restyles the rows from that point on; prepending restyles the
list, correctly, since every row's `:nth-child` position changed. A change restyles what sits beside
the list as well only when it may have made the list empty or ended its being empty: when the list
holds no element, or text node with any data, that it held before the change. A comment does not
count toward `:empty`, so the first row into an empty list that holds only a framework's comment
anchor restyles the list's neighbours. A log that drops its oldest row as each new one arrives keeps
its other rows, so it restyles its rows and leaves the rest of the panel alone.

```css
.row:nth-child(even) {
  background: #f4f4f5;
} /* fine */
.row:last-child {
  border-bottom: none;
} /* fine */
.row:nth-last-child(2) {
  opacity: 0.5;
} /* ignored — counted from the end */
```

Followed:

- Every attribute change, with the restyle and re-measure above; `hidden` and `display` changes
  resize the panel around them.
- The document's stylesheets changing (see [Stylesheets](./css#stylesheets)).
- `opacity`, as the product of the element's and every ancestor's up to the panel's top, on each box
  and run of text.
- A border width per side, and one border colour: the colour of the first side that draws a border,
  in the order top, right, bottom, left. A side with no width, or a transparent one, draws none, so
  a divider under `border-top: 2px solid transparent` is drawn in its own colour.

Not followed:

- A layout change under `data-xr-hover`, `data-xr-active`, `data-xr-checked` or `data-xr-focus`, and
  a sibling combinator on all but `data-xr-checked`.
- `:nth-last-child` and `:nth-last-of-type`: a row appended at the end shifts every earlier row's
  position from the end, and following them would restyle the whole list on every append.
- `:has()`: a change to the rows does not restyle a list or an ancestor matched by what it contains.
- `:empty` moved by a text node's data: the mirror judges a text node by the data it has after the
  flush, so a list's only text node emptied, or an empty one filled as the list's first row arrives,
  does not restyle what sits beside the list.
- A rule like `circle[cx="3"] ~ circle` on an SVG geometry attribute.
- A rule that selects on `data-xr-portal`, `data-xr-loading` or `data-xr-busy`: the container is
  above every element in the panel, and the mirror ignores it.
- Sides bordered in different colours are drawn in the first side's, and a dashed, dotted or double
  border is drawn solid.
- `opacity` where what is inside overlaps: a browser fades the subtree as one layer, and a panel
  fades each box and run, so a child shows through the one under it.
- A classic scrollbar brought in by a positioned box grown past the bottom of a scroller, on a
  desktop page.

### The panel's background

A ray that lands on the panel but on none of its buttons hits the blocker spanning the container,
which dispatches a bubbling `click` on the portal's root element. That is what "clicked outside"
means to a menu that wants to close itself. The click carries the point the ray met, so a `<canvas>`
board, which is not `cursor: pointer` and takes its clicks this way, finds the square from `clientX`
and `clientY`; so does the click a press on a scrolling list's own padding sends when it became no
scroll, and the one a press on an overlay's own background sends the overlay.

Count only the panel's own clicks as elsewhere, via `getPortalRoot(node)`, and ask it when the click
arrives rather than when the listener goes up, since which panel a node is in changes as a session
starts and ends:

```js
document.addEventListener("click", (event) => {
  if (root.contains(event.target)) return; // inside
  const panel = getPortalRoot(root);
  if (panel && !panel.contains(event.target)) return; // the page, not the panel
  close();
});
```

Every real mouse click on the page around the scene — the VR button, and in development an emulator
whose every control is a mouse click — also reaches the document, and a menu that counted those
would close itself the moment you reach for the control that was going to choose from it.
`getPortalRoot` returns null off a portal, where the whole page is the right scope. The `dropdown`
and `scrollable` widgets in [`justdom-three-ui`](../three-ui) do it this way.

A panel with nothing to press can say so and stop stopping rays:

```js
dom(ctx, panel, [set({ position })], { opaqueToRays: false });
```

That is for readouts, and mainly for a head-locked overlay, which rides between the eye and the
whole scene. What goes is the panel's own background, and only that: a `cursor: pointer` element
inside is still a ray target.

### Loading, budget and updates

Building a mirrored element costs real work — an object, its measurements, its place in the batches
— so the portal queues what the observer reports and spends a budget of each frame on it, and the
frame keeps its rate however large the mount.

| Option             | Default                                           | What it does                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portalBudget`     | three tenths of the frame, clamped to 1.5 to 8 ms | On `render()`: milliseconds of each frame every portal in the scene shares, a number or a getter read at the top of every frame; the default is 5 ms at 60 Hz and 8 ms at 30 (`createFrameShareBudget`). |
| `priority`         | `0`                                               | Pumps of higher priority are offered each frame's pool before lower ones; within a priority the offer rotates frame by frame.                                                                            |
| `budget`           | `5`                                               | Milliseconds per frame for a portal built outside a rendering context, which paces itself; ignored under `render()`.                                                                                     |
| `atomic`           | `true`                                            | An update lands whole, in the frame that finds nothing left to read; `false` runs the writes under the budget and lets the panel change in instalments.                                                  |
| `loadingFrame`     | `{ delay: 250, minimumTime: 500 }`                | The frame shown where the panel will be while a long mount runs; `false` for none. Also `color` (black), `fill` (white), `fillOpacity` (0.2), `borderWidth` (2), `radius` (12).                          |
| `onLoadingChanged` | none                                              | Called once, with `false`, when everything the initial content brought has been built and settled.                                                                                                       |

```js
render(Scene, {
  // A sliver while a hand is busy, generous otherwise; `Infinity` would
  // finish every mount in flight within the next frame.
  portalBudget: () => (interacting.get() ? 1 : 8),
});

dom(ctx, panel, [set({ position })], { priority: 1 });
dom(ctx, readout, [set({ position })], { loadingFrame: false });
dom(ctx, menu, [set({ position })], {
  loadingFrame: { color: "white", fill: "black", fillOpacity: 0.4, radius: 8 },
});
```

- **The budget is the scene's, not the panel's.** `render()` installs one scheduler per rendering
  context, and every portal under it draws frame time from the same pool, since three panels each
  honouring a private five milliseconds would cost the frame fifteen. The budget bounds when work
  stops being started, not how long a piece takes: at least one element is built and at least one
  update runs per frame. The grain is the element, not the inserted subtree. Where there are no
  frames to slice across — no renderer and no `requestAnimationFrame`, as under a test runner — the
  portal mounts synchronously.
- **A panel is loading until its initial content is whole.** While that runs it stops no rays and,
  if the mount outruns `delay`, shows the loading frame: a translucent rounded rectangle the panel's
  size, with three dots that brighten in turn, placed exactly where the panel will be and replaced
  by the panel in the same frame. Once shown it stays up for `minimumTime` at the least, the mount
  held built and unseen until then. Loading ends exactly once; a panel that is already visible never
  shows the frame again. The container carries `data-xr-loading` from the first content it is given
  to the load, so a harness can ask `document.querySelector("[data-xr-loading]")`. A panel given
  nothing to mount never carries it.
- **A shader is linked once per renderer.** three.js deletes a compiled program when the last
  material using it is disposed, and links it again for the next material that needs it, which costs
  15 to 19 ms on a Quest 3. The package keeps one extra material of each kind it draws, for the
  screen and for a render target such as a drag's snapshot, for as long as the renderer's GL context
  lasts (`programKeeper.js`). So a panel mounted after the last of its kind has closed, a text
  bucket that grows, a loading frame and a panel's handle bars link nothing that was linked before.
- **An update lands whole.** The panel's channel is atomic (`UpdateChannel`'s option of that name in
  `justdom-signal`): each frame's budget goes on resolving what the update will read, and the writes
  to the scene happen together, in the frame that finds nothing left to resolve. Until then the
  panel stands exactly as it was, its own size and placement included, and objects built for rows
  that arrived wait for it too, as do the objects of rows that left. The wait has a bound. Once a
  panel has nothing left to build and has waited a second (`MAX_COMMIT_WAIT` in `portalPump.js`) for
  its reading to finish, the next frame reads everything at once and the update lands, so under
  input that never stops — an endless animation, a timer faster than a slow frame, a drag — the
  panel lands in one long frame about once a second. Once the page adds a node five seconds or more
  into a mount (`MAX_BUILD_WAIT`), one frame builds everything queued. A loading frame still up for
  its minimum time holds both. A drag whose reading fits the budget commits every frame on an atomic
  panel too; one whose reading overruns it on every frame wants `atomic: false`.
- **A transform animating on its own does not wait for the update.** An HTML element whose only
  animated property is its `transform` is drawn at its new transform in the frame the animation is
  sampled, whatever the panel's channel still holds: each box writes its matrix in a channel of its
  own, from the layout the panel last committed and the transform as it is now. A step that would
  change the order the panel is drawn in waits for the commit: one that makes the element a layer or
  stops it being one (a `translateZ`, a 3D rotation), one that changes whether it is placed by a
  matrix or which painting layer it is in (a transform appearing or going), or, for an element that
  is not a layer, one that moves it onto or off a positioned or transformed sibling that is not a
  layer either. Its transform is drawn from that commit on. An SVG element's transform, and one
  animated beside any other property, still lands with the update.
- **`data-xr-busy`** is on the container while a panel has work it will do on a coming frame — an
  animation the clock is sampling, an update the pump has not yet brought into the scene — and comes
  off on the frame that draws the last of it. A harness pins the page's animations, then waits for
  `document.querySelector("[data-xr-busy]")` to come back empty.
- **A scroll is never deferred.** Everything the offset moves — the content group's translation, the
  clip boxes, the culling at the window's edges — is arithmetic on cached values and settles
  synchronously in the event that carried the scroll, whatever the budget.
- **A panel closes at once and is taken down afterwards.** `disconnect`, which `dom()` calls when
  its panel goes, takes the panel out of the scene and out of the rays, and the portal's marks and
  flags off the page, in the task that closes it. What its objects hold, about a hundred reactive
  nodes for each element, is let go of over the frames that follow, in the time the budget has left
  once every panel mounting or updating has had its share. A list of a hundred rows that took 46 ms
  to close in Chromium takes 2.4 ms, and its objects are gone ten frames later
  (`bench/dispose.browser.mjs`). Only under `render()`, whose scheduler outlives the panel: a portal
  pacing itself takes everything down at once. A scene that stops drawing, as a `presentingOnly`
  scene does when its session ends, goes on taking the panel down on timers, 4 ms at a time, and a
  portal claiming the same element again first finishes what is left for the element and everything
  under it. The rows that leave an open panel go the same way: out of the scene at the commit that
  closes the gap, and taken down over the frames after it. Emptying a list of a hundred rows cost a
  100 ms frame in Chromium and costs one of 33 to 50 ms, the rest of which is the update before the
  commit. A row put back before its teardown has run takes its own teardown with its build, and
  leaves the others to their frames. `portalTeardown.js` has the rules.

### Dragging and dropping

A page that sorts a list or moves cards between columns with the browser's drag and drop works in a
panel unchanged: the panel sends the same events the browser would, in the same order, to the same
elements.

```html
<div class="column">
  <div class="card" draggable="true">…</div>
</div>
```

```js
card.addEventListener("dragstart", (event) => {
  event.dataTransfer.setData("text/plain", card.id);
  event.dataTransfer.effectAllowed = "move";
});
column.addEventListener("dragover", (event) => {
  event.preventDefault(); // this column takes drops
  event.dataTransfer.dropEffect = "move";
});
column.addEventListener("drop", (event) => {
  event.preventDefault();
  const id = event.dataTransfer.getData("text/plain");
  column.append(document.getElementById(id));
});
```

The gesture is a mouse drag done with the trigger. Closing it on a `draggable="true"` element, or on
anything inside one, is a `mousedown`. While the hand has moved less than the scroll gesture's few
px the press is still a press, and letting go is a click. Past that the page gets `dragstart` on the
draggable element and, right after one it let through, `pointercancel`. After it, once a frame, the
source gets `drag` and the element under the ray gets `dragover`, with `dragenter` and `dragleave`
as the ray moves from one element to the next. Opening the trigger sends `drop` to the element under
the ray, if its last `dragover` was cancelled, and `dragleave` to it otherwise. `dragend` goes to
the source either way. A drag sends no `mouseup` and no `click`.

Followed, as the browser's rules:

- Cancelling `mousedown` stops the press from becoming a drag, and cancelling `dragstart` leaves an
  ordinary press that ends in a click.
- An element takes a drop only by cancelling `dragover`. Its `dropEffect` then has to be one the
  source's `effectAllowed` allows, or the drop is refused. `dragend` carries the operation that
  happened in its `dropEffect`, `"none"` for a drop nobody took.
- `dataTransfer` is writable in `dragstart` only. During the drag a handler sees `types` but
  `getData` returns `""`, and `drop` reads the data.
- The element under the ray can be any element in the panel, not only a ray target, found the way a
  page hit-tests: later siblings over earlier ones, children over their parents,
  `pointer-events: none` and `visibility: hidden` letting the ray through, and nothing found where
  an overflow-clipping ancestor cuts an element off.
- The events carry `clientX` and `clientY`. `dragstart`, a drag's arrival on another panel and
  `drop` read where the page lays the panel out; the other frames take the corner last read, as a
  `mousemove` does.
- `:hover` does not change under a drag: the elements the ray crosses take no `data-xr-hover` and
  hear no `mousemove` until the trigger opens, and the control the ray is on then takes it on the
  next move.
- What a page draws while it drags — a class, an inline style, an attribute of its own — and
  `draggable` itself: a row made draggable after the panel was built can be picked up.
- A drag can end on another panel in the scene, or on nothing, where letting go drops nothing. A
  drag whose panel is taken down, or whose controller is lost, is cancelled with a `dragleave` and a
  `dragend` whose `dropEffect` is `"none"`.
- A translucent card the size of the source, or of what `setDragImage` was given, follows the ray in
  the panel the ray is on, and in the plane of the last panel it was on while it is on none. It is a
  picture of the source taken once, at `dragstart`, by rendering the source's panel into a texture
  through a camera framed on the element's box: one render pass per drag, nothing per frame, with
  the shaders compiled when the press begins. Every panel in the scene knows a hand is carrying
  something, so no control takes hover under a drag.

Not followed:

- Only `draggable="true"` makes an element draggable. Images and links are not, since what a browser
  drags out of them is a URL for another application, and counting them would take scrolling away
  from every list of links.
- `dataTransfer.files` is always empty and there is no `dataTransfer.items`: nothing is dragged in
  from outside the page.
- A drag does not scroll a list it is held near the edge of.
- The ghost pictures what the panel draws behind the element inside its box, the card it sits on
  included, where a browser's has the element and its descendants alone. It is the element's outline
  instead where there is nothing to take a picture of: without a WebGL renderer, as under a test
  runner, and for a drag image the source's panel does not draw.

### Haptics

Every control in a panel — every element the ray-target rule covers — pulses the controller's motors
when the trigger closes on it, and the grip as well, as it closes and as it opens. Not a grip that
something above the panel took as a grab, nor one closed while the trigger carries a row or moves a
list; a grip not felt closing is not felt opening either. Nothing is marked: a panel with buttons in
it is felt, and so is the keyboard.

```js
dom(ctx, numberPad, [set({ position })], {
  haptics: { hover: true, strength: 0.6, flavor: "knock" },
});
```

| Option     | Default  | What it does                                                                                                                                                                                                                                                                                                               |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hover`    | `false`  | Whether the ray arriving on a control is felt. On for the keyboard a field brings up unless the panel says `hover: false` by name.                                                                                                                                                                                         |
| `active`   | `true`   | Whether a press is felt, and its release where the flavor has one.                                                                                                                                                                                                                                                         |
| `strength` | `1`      | Multiplies every pulse, clamped to what the motors can do.                                                                                                                                                                                                                                                                 |
| `flavor`   | `"tick"` | `tick` (a light high-frequency click), `knock` (the low motor, a thump), `buzz` (longer and softer), `key` (a mechanical key, felt closing and opening), or a `HapticFlavor`: a `hover` pulse, a `press` pulse and an optional `release` pulse, each a `duration` in ms and a `strong` and a `weak` magnitude from 0 to 1. |

`false` is no haptics for the panel whatever the scene says; there is no `true`, for the reason
`loadingFrame` has none. `HAPTIC_FLAVORS` holds the named flavors to start from.

- **What plays is the hand's own.** The event carries the input source three connected to the
  controller, and every actuator of its gamepad gets a `dual-rumble` effect, or a `pulse` on a
  runtime that only has that. A tracked hand has no motors and feels nothing.
  `playHaptic(source, effect)` is that driver on its own, for a scene with haptics of its own to
  play, and `playHapticAll(session, effect)` plays one effect on every input source of a session,
  doing nothing when the session is null.
- **A hover is one pulse per arrival on a control.** The control is the outermost element in the
  unbroken run of clickable ancestors and everything in it, so a ray moving between a button's
  background and its label plays nothing; coming from another control or from a scrollable list,
  which is a ray target to be dragged by and not a control, is an arrival. Nothing on the panel
  being scrolled plays while the hand is scrolling it, glide included; a control on another panel
  the ray crosses meanwhile is entered as usual. `haptics.js` says how the enter's `relatedTarget`
  decides it.
- The keyboard a field brings up follows the `haptics` of the panel it is typing for, with the hover
  on; a panel with `haptics: false` has a silent board too.

Not followed: a distinct control nested in another — a delete button inside a clickable row — whose
hover from the row is not an arrival. Its press still is.

## Baking a panel into a stamp

A portal is the right price for a panel, which is a view of something that keeps changing, and the
wrong price for a _picture_ — a card, a number chit, a badge — which is the same in every copy of
itself. `createBakery(ctx, faces, options)` draws each distinct face exactly once, into an oven
parked out of sight, and hands out copies:

```js
const bakery = createBakery(ctx, {
  timber: () => card("TIMBER", "#2f6b3a"),
  clay: () => card("CLAY", "#b4553a"),
});

useEffects(getScene(ctx), [
  children(
    bakery.oven(),
    component(() => {
      const stamp = bakery.stamp("timber");
      return stamp ? $(stamp) : Nothing();
    })(),
  ),
]);
```

| Option         | Default | What it does                                                                                                      |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `settleFrames` | `3`     | How many frames to wait after the last face reports itself mounted; a test driving its own frames may want fewer. |

- `oven()` is mounted once, anywhere in the scene, and draws nothing anybody sees. `stamp(name)`
  returns null while the oven is working and a fresh copy afterwards; `ready()` is reactive. A face
  the bakery was never given throws.
- A stamp is a `clone()` of the finished portal's tree, sharing its geometry, materials and
  textures, so it costs a handful of objects and no DOM. Stamps keep their matrices the way the
  panel they came from does (see [Placing a panel](#placing-a-panel)).
- **The oven's portals are never disconnected, and must not be**: disconnecting one disposes what
  every stamp holds a reference to. Keeping them costs a matrix comparison per portal per frame and
  nothing else, since the DOM never changes again.

Not followed: stamps are not interactive. Nothing inside a baked face registers as a ray target, and
a clone would not carry the registration if it did; anything that has to be pressed wants a plain
invisible mesh in front of it.

## Checkboxes

`<input type="checkbox">` is projected as a component of its own — a box with a mark in it — and the
tick is drawn in the scene, in the element's own `color`:

```css
.done {
  appearance: none;
  width: 1.25rem;
  height: 1.25rem;
  border: 2px solid #ccc;
  border-radius: 4px;
  background: white;
  color: white; /* the tick */
}

.done:checked,
.done[data-xr-checked] {
  background: #007bff;
  border-color: #007bff;
}
```

- Everything but the tick comes from the same declarations any other box is drawn from.
  `appearance: none` is implied in a scene and is what the flat build needs to match.
- A checkbox is a ray target without asking; `cursor: pointer` is still worth writing for the page,
  and a disabled checkbox is not pointable however it is dressed.
- The ticked state is written back onto the element as `data-xr-checked`, since `:checked` changes
  no attribute. It carries the presentational contract `data-xr-hover` does — a ticked box may
  change colour, not size — but not hover's other restriction: `input[data-xr-checked] + .label`
  works and is the form to reach for.
- The DOM stays the thing that is true. A ray's click is a click, so the browser toggles and fires
  `change`, and an app reads `checked` and listens for `change` as on a page, `set("checked", …)`
  from the other direction included: the portal hears an assignment through an accessor of its own
  on the element, there while a panel shows the box and taken off once none does.

Not followed: every other kind of `<input>` but the text fields below is drawn as a plain box. A
range's thumb, a colour swatch and a file picker's button are chrome the DOM does not describe.

## Text fields and the keyboard

`<input type="text">`, and the other types that hold a line of text (`search`, `url`, `tel`,
`email`, `password`, `number`), are drawn as a box with the value in it, or the placeholder while
the value is empty, in the colour the page gives placeholders. A field is a ray target without
asking, and a disabled one is not. The value is not a text node, so the portal follows it through
the `input` and `change` events a keystroke dispatches and through the `value` property itself,
intercepted on the element for as long as the portal watches it, so that `input.value = ""` after a
submit is followed. A `value` or `placeholder` attribute rewritten from outside is followed too.

Typing into one needs a keyboard, and the system's never reaches the panel. What does is a board of
ordinary boxes, mirrored by a portal of its own; `keyboard(props)` in
[`justdom-three-ui`](../three-ui) is one. This package has no keyboard and does not depend on one,
so a scene gives it a factory, once, for every panel:

```js
import { keyboard } from "justdom-three-ui";

render(Scene, {
  panelOptions: {
    keyboard: {
      create: ({ onKey, field }) => keyboard({ classes, onKey, field }),
    },
  },
});

dom(ctx, codeEntry, [], { keyboard: { create: ({ onKey }) => codeKeyboard(onKey) } });
dom(ctx, readout, [], { keyboard: false });
```

| Option      | Default    | What it does                                                                                                                                                                                          |
| ----------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`    | required   | Builds the board's DOM for a field, wired to the `onKey` it is given. `field()` says which field it is typing into, `element` the one it was built for, `dismiss()` closes it.                        |
| `placement` | `"viewer"` | `"viewer"` opens the board in front of the player and leaves it there; `"panel"` hangs it below the panel of the field being typed into; a function poses it when it opens (see `KeyboardPlacement`). |
| `reach`     | `0.45`     | Metres ahead of the eyes the board's top edge opens, with `"viewer"`.                                                                                                                                 |
| `drop`      | `0.2`      | Metres below the eyes, with `"viewer"`.                                                                                                                                                               |
| `tilt`      | 24°        | How far the board is reclined toward the viewer, in radians, hinged at its top edge.                                                                                                                  |
| `scale`     | `0.001`    | Metres per CSS px of the board, with `"viewer"`; `"panel"` uses the panel's scale.                                                                                                                    |
| `gap`       | `12`       | Px between the panel's bottom edge and the board's top, with `"panel"`.                                                                                                                               |
| `preview`   | `true`     | Whether a board in the room carries a copy of the field above its keys; an object sets `tilt` (15°), `gap` (8 px) and `className`. Not used by `"panel"`.                                             |

A panel's `keyboard` is laid over the scene's, so a panel for entering a code can bring a different
board, and `keyboard: false` gives a panel none. A portal built outside `render()` keeps a board of
its own, given its own `keyboard` option. Without a keyboard a field is drawn and pressed like any
box, and nothing in the scene can type into it, which is what a read-only readout in an `<input>`
wants.

- **There is one board for the whole scene.** Whichever field was pressed last is the one being
  typed into, whatever panel it is in: the board stays up, `onKey` types into the new field, and
  `field()` says which. The board is only built again if that panel's keyboard has a different
  `create`.
- **It opens in front of the player**, turned toward them and reclined by `tilt`, and stays where it
  is in the room until it goes. The `placement` the board opens with is the opening panel's and
  holds until the board goes: a field pressed in a panel that asks for another placement types into
  the board where it already is. A board in the room keeps the opening panel's `scale` and `tilt`
  too. A board below a panel moves to the panel of the field being typed into, and takes `gap`,
  `tilt` and its scale from whichever panel it hangs below. On a plain page, or under a test runner,
  it hangs below the panel.
- **It can be moved.** A board in the room has the strips a draggable panel has (see **Letting the
  player move a panel**), without asking for them as a panel does. The carry takes the anchor the
  board hangs from, so the next board opens where the player put the last one down, unless they have
  since walked more than a metre or turned more than 60° away. A board below a panel has no strips,
  moves with the panel, and does not show the panel's strips when a ray is on its keys.
- **It shows what is being typed.** A board in the room carries a copy of the field above its keys:
  the value as it is typed, the placeholder while it is empty, the caret where the next key goes,
  hinged toward the player. It is unmasked, since only the player can see it. It wears the field's
  own look unless `preview.className` names a class of the app's, and carries
  `data-xr-keyboard-preview` (`PREVIEW_ATTRIBUTE`) either way. Its caret is placed by a ray, as the
  field's is, and goes into the field.
- **A key goes into the field through `typeIntoInput(input, press)`**, exported too: the character
  goes in at the caret, backspace takes one out, and `keydown`, `input` and `keyup` are dispatched
  in a browser's order. `Enter` asks the field's form to submit, if it is in one, and keeps the
  field being typed into, so an app that clears the field after a submit can take the next entry
  straight away. While the board is up the field carries `data-xr-focus` (`FOCUS_ATTRIBUTE`), a
  presentational flag like `data-xr-hover`, and a caret.
- **The board follows focus the way a page does.** A press anywhere in a panel with a keyboard other
  than on a field — a button, a row, the background — is focus leaving the field, and the board
  goes; a press on another field moves the typing there, and so does a press on a field's `<label>`,
  which is a ray target whatever its `cursor` unless it is under `pointer-events: none`. A label of
  a field outside the panel, or of one that is read-only or disabled, is anywhere else, and so is a
  button, a link or another control inside a label. The board also goes on `Escape`, which a board
  can offer as its "done" key, when the field leaves the document or its panel goes, when the
  session ends, and with the scene; `dismiss` on the target closes it for any other reason.
- **The caret.** Pressing a field puts the caret at the end of the entry; once the field is being
  typed into, a press puts it between the two characters nearest where the ray landed, and holding
  the trigger while the ray slides along the field drags it, for as long as the ray is on the field.
  A password is measured by its bullets. The mirror scrolls the value as a page does, only when the
  caret would leave the field and only as far as it takes to bring it back. The caret blinks every
  530 ms, stays solid for a moment after each keystroke, and is a mesh of its own, so a blink flips
  its visibility and nothing on the panel is drawn again.
- **A number field is typed the way a page types one.** `1.` on the way to `1.5` is not a number, so
  `value` reads `""` while the field keeps a draft of what was typed and the mirror draws it.
  `input` is dispatched for every key, the ones that leave `value` empty included. A letter never
  gets in. The draft goes when the app writes the value.

Not followed:

- No selection, only a caret.
- `number` and `email` fields keep a caret the page cannot reach — `selectionStart` reads null and
  `setSelectionRange` throws on them — so one placed by a ray is kept alongside the field instead,
  and typing goes in there all the same. A value the app writes puts it back at the end.
- A press in a panel with `keyboard: false`, or on the scene outside every panel, leaves the board
  up: only a panel with a keyboard listens for the press that dismisses it.
- The keyboard's preview shows a password unmasked, by design.
- A `<textarea>` is a plain box: its value is not drawn, and it cannot be typed into or scrolled.

## Placing a panel

Everything a portal draws composes its local matrix once, in the effect that placed it, rather than
being recomposed every frame on the chance it moved, which is most of what makes an idle panel
cheap. Place the panel however you like:

```js
$(new THREE.Group(), [
  effects((group) => {
    group.position.set(0, 1, -2);
    group.scale.setScalar(0.01);
  }),
  children(dom(ctx, App(ctx))),
]);
```

three propagates a recompute downwards, so a group left on three's defaults would hand a panel below
it back all the work it opted out of. A portal declines that at its own perimeter: it recomputes its
own world matrix each pass and passes the recompute on only when that matrix came out different, so
a panel that is not moving costs a matrix multiply (`place.js` says how). `place` and
`placeAndScale` are exported for a scene's own static objects:

```js
import { place, placeAndScale } from "justdom-three";

placeAndScale(group, 0, 1, -2, 0.01, 0.01, 0.01);
```

Both take the object first and commit its matrix, since a bare `position.set` on such an object
would leave it wherever it last was. Set a rotation before the call if you need one: they compose
from position, quaternion and scale.

### Letting the player move a panel

```js
dom(ctx, Settings(ctx), [], { draggable: true });
dom(ctx, Map(ctx), [], { draggable: { level: false, handleWidth: 20 } });
```

| Option        | Default   | What it does                                                                                                         |
| ------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `handleWidth` | `14`      | The strips' width, in the panel's px.                                                                                |
| `level`       | `true`    | Turn only about the vertical and keep the tilt the scene gave the panel; `false` gives it the hand's whole rotation. |
| `carried`     | the panel | An ancestor to move instead, so the panel moves together with whatever it hangs from.                                |
| `onPutDown`   | none      | Called when a carry ends, which is where a scene saves the panel's new place.                                        |

- Four strips along the panel's edges are invisible until a ray is on the panel, faint while one is,
  and full on the strip the ray is on and on all four while the panel is held. While the panel loads
  they are not there at all, until its loading frame shows, and a keyboard's board, which has no
  loading frame, has none until it loads. They draw after every panel, so a panel behind one never
  covers it, and a panel in front of one hides it. A press on a strip picks the panel up with
  `carry()`, and the release puts it down; a press on the panel itself means what it always meant.
- The portal puts a group of its own between the parent and the panel, and the carry moves that
  group, so whatever the scene does to place the parent still applies.
- Dragging is off unless a panel asks for it, and it is not one of the scene's panel defaults. A
  carry follows the hand in the renderer's frames, so a portal without a renderer has no strips. The
  keyboard uses the same strips, and in the room has them without asking.

### How sharp the text comes out

The scale a panel is placed at is also what decides how finely its text is rasterized. Each panel
measures how many device pixels it paints per CSS pixel, once a frame, and rasterizes at a step of
the ladder 1, √2, 2, 2√2, 4, the one at or above what it measured. Coarsening is held back until the
measurement is a fifth clear of the boundary, so a panel you are standing in front of does not
re-rasterize because you drifted a centimetre. `textScale.js` says why the ladder is in steps of
root two and why four is the ceiling.

```js
dom(ctx, List(ctx), [], { maxTextScale: 2 });
```

`maxTextScale` lowers that ceiling for a panel that would rather be soft than large, such as a list
of hundreds of rows, which reaches the ceiling with every row at once; what a step costs is
quadratic in it. It only ever lowers. Off a scene — a portal on a plain page, or under a test runner
— the page's `devicePixelRatio` is the whole answer, since the panel _is_ the page.

A run keeps what it drew at the step below the one its panel shows. A player who leans in crosses
into a step and then usually leans back out of it, and the step they come back to is the one below:
the panel shows it again without drawing anything or uploading anything, from the rasters and the
arrays it kept. Holding the step below costs half again what the shown step costs, since a step
costs half the one above it.

And the step above is drawn before it is needed. Once the measurement comes within 0.85 of the step
a panel shows, the panel draws every run at the step above, a run at a time, in whatever frame time
the panels' own work leaves, and then sends what it drew to the GPU, at most 512 kB of arrays a
frame. Walking on across the boundary then swaps textures and draws nothing. If the measurement
falls back under 0.85 for a second, the panel lets that step go. Any other step, two below or one
above that is not being prepared, is let go of as the panel moves on. While a step is prepared, a
panel keeps up to three and a half times what the shown step costs: the step below at half and the
step above at twice.

### Panel defaults

Some of what a panel is told belongs to the scene rather than to any one panel. `render()` takes
them once, as `panelOptions`, and every panel in the scene starts from them:

```js
render(Scene, {
  panelOptions: {
    maxTextScale: 2,
    loadingFrame: { delay: 400 },
    keyboard: { create: ({ onKey, field }) => keyboard({ classes, onKey, field }) },
  },
});
```

`keyboard`, `loadingFrame`, `haptics`, `thumbstickWheel`, `maxTextScale`, `atomic`, `opaqueToRays`,
`priority` and `budget` can be set this way. A panel's own options are laid over them: its value
wins, except that a `keyboard`, a `loadingFrame` or a `haptics` given as an object is spread over
the scene's, so a panel can change one thing about them without restating the rest; `false` at
either level is none, for those three. `withPanelOptions(ctx, options)` does the same for a part of
the scene, over whatever is in scope already. `plugins` is not among them — it has `portalPlugins`,
whose list a panel's own is put in front of rather than in place of — and neither are `root`,
`draggable` and `onLoadingChanged`, which are only ever one panel's.

## Element plugins

The seam the SVG support goes through is general. A `PortalPlugin` is an object with one method,
`element(ctx, element)`, asked about every element a portal is about to build, before its own
dispatch; it returns the object tree to mirror the element with — one `Object3D`, emitted
synchronously, kept in step with the element for as long as the subscription lasts, torn down when
it ends — or `null` for an element that is not its. Register one for a scene with `render()`'s
`portalPlugins` or for one panel with `PortalOptions.plugins`; a panel's are asked first.
`box(ctx, element, options)` is exported for a plugin that wants the CSS box drawn and something of
its own inside it, which is how the checkbox is built: `clickable` says whether the element is a ray
target, `content` what else belongs inside the box, and `contentMatrix` where the element's children
are drawn from, if not from its border-box corner. A plugin cannot rebuild the built-in controls:
the checkbox's and the text field's helpers are internal.
