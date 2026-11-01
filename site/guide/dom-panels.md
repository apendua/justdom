# DOM panels

A menu, a HUD, a form, a keyboard: the interface of a headset app is ordinary DOM, built with
[`justdom`](./rendering-the-dom) and styled with CSS, and [`justdom-three`](/api/three/panels)
projects it into the scene through a **portal**. The panel is drawn from the elements' computed
style, a ray on it sends the page the events a mouse would, and the DOM stays the thing that is
true: a ray's click is a click, so the app's handlers are the ones a page would have.

## Two ways to get a panel

`dom(ctx, source, effects, options)` mounts a component tree into a container of the portal's own,
for a panel that exists only in the scene:

```js
import { dom } from "justdom-three";

$(new THREE.Group(), [
  effects((group) => {
    group.position.set(0, 1, -2);
    group.scale.setScalar(0.01); // a centimetre a px becomes a millimetre
  }),
  children(dom(ctx, Menu(ctx))),
]);
```

Or it mirrors an element the page already has, where it stands. An app that delivers a flat
interface first, and a session as something extra, already has its DOM, laid out, styled and wired
to its state, and nothing is built twice:

```js
const hud = document.getElementById("hud");
dom(ctx, hud, [set({ position })]);
```

The element stays in the document with the styles the page gave it. Whatever it holds when the
portal is built is the initial content, whatever the page does to it afterwards is followed, and
when the session ends the page is as it was. The element is the panel's frame, so a card goes inside
it, not on it; it has to be in the document and laid out, so hide the page's own view with
`visibility: hidden` or cover it rather than `display: none`; and neither it nor anything above it
may be rotated or skewed.
[Mirroring DOM the page already has](/api/three/panels#mirroring-dom-the-page-already-has) has the
rules. The <a href="/demos/todo/" target="_self">todo demo</a> works this way.

A panel is centred on its origin, a centimetre a px, and the group it hangs from places and scales
it. Everything the portal draws composes its matrix once, in the effect that placed it, so an idle
panel costs a matrix multiply a frame.

## What a ray does to the page

An element is a ray target when its computed `cursor` is `pointer`, the signal a page uses for
"clickable", and checkboxes, text fields and `draggable="true"` elements are targets without asking.
Closing the trigger on one sends `pointerdown` and `mousedown`; opening it sends `pointerup`,
`mouseup` and `click`. The grip is the mouse's other button, arriving as `contextmenu`. Every event
carries `clientX` and `clientY` mapped onto the page's layout, so a page that finds what was pressed
from where it was pressed, a board drawn as one `<svg>`, reads the place a mouse would have given
it.

Hover and press are written onto the element as attributes, since `:hover` and `:active` cannot be
set from outside: `data-xr-hover` while a ray is on it and `data-xr-active` while it is held. A
stylesheet styles both states in one rule, and the same for a ticked box and a focused field:

```css
.button:hover,
.button[data-xr-hover] {
  background: #0056b3;
}
.done:checked,
.done[data-xr-checked] {
  background: #007bff;
}
```

These four attributes are presentational by contract: a rule on them may change colour, opacity and
`transform`, never size or layout, and three of the four may only style the element they match and
its subtree. [Writing CSS for a panel](./panel-css) says what that buys.

A ray that lands on the panel but on none of its controls clicks the panel's root element, which is
what "clicked outside" means to a menu that wants to close itself; `getPortalRoot(node)` from
`justdom-three/page` scopes that listener to the panel the node is in, so that a real mouse click on
the page's own controls does not close it. Scrolling needs nothing: a list that hides its overflow
is pulled with the trigger the moment it has more inside than fits, and the browser's drag and drop
works in a panel unchanged, with the same events to the same elements.

## Typing

A text field in a panel is drawn with its value or its placeholder, and pressing it brings up a
keyboard: a board of ordinary boxes mirrored by a portal of its own, which a scene gives to every
panel once through `render()`'s `panelOptions`. `keyboard(props)` from
[`justdom-three-ui`](/api/three-ui) is such a board, dressed in the app's own classes:

```js
import { keyboard } from "justdom-three-ui";

render(Scene, {
  panelOptions: {
    keyboard: { create: ({ onKey, field }) => keyboard({ classes, onKey, field }) },
  },
});
```

The board opens in front of the player, types into whichever field was pressed last on any panel,
goes when a press lands anywhere but a field, and puts each key into the field through the
`keydown`, `input` and `keyup` events a page already listens for. A number field gets the number
pad.

## Widgets that work in a room

A native `<select>` cannot be mirrored, since `<option>` has no CSS box and the list the browser
pops up is chrome, and the system keyboard never reaches the panel. `justdom-three-ui` has the
widgets built out of ordinary elements instead: `dropdown(props)`, `keyboard(props)`,
`scrollable(props)` for a list with arrows, a track and a thumb, and
`useDiagnostics(ctx, controls)`, the frame rate readout head-locked in the room, where the reading
that matters can be seen. None of them ships a colour; each is dressed in class names the caller
supplies.

## What it costs, and when it lands

Building a mirrored element is real work, so the portal spends a budget of each frame on it, shared
by every panel in the scene, and the frame keeps its rate however large the mount. A panel is
loading until its initial content is whole, and shows a loading frame where it will be if the mount
takes longer than a quarter of a second. An update lands whole, in the frame that finds nothing left
to read, so the panel never shows half of a change. A panel's teardown is spread over the frames
that follow its closing. [Loading, budget and updates](/api/three/panels#loading-budget-and-updates)
has the numbers and the options, `portalBudget` on `render()` first among them.

## Moving a panel

`dom(ctx, Settings(ctx), [], { draggable: true })` gives a panel four strips along its edges, faint
while a ray is on the panel, that pick it up with a
[carry](./pointing-and-grabbing#carrying-things-level) and put it down where the hand leaves it. The
keyboard has them without asking.
