# justdom-three-ui

The widgets a panel is made of, for panels that have to work in a room as well as on a page: a
dropdown, a keyboard, a scrolling window with a bar, and the frame rate readout every headset app
here wears.

All of it is ordinary DOM. [`justdom`](../justdom) builds the trees and
[`justdom-signal`](../signal) keeps them current, which is what lets the same widget be a control on
a flat page and a control in a scene — a [`justdom-three`](../three) portal mirrors elements, so
anything built out of elements can be pointed at with a ray.

## Installation

```
npm install justdom-three-ui justdom-three justdom justdom-signal three
```

`freedom`, `justdom`, `signal` and `three` are peer dependencies. Only the diagnostics panel
actually reaches for three.js; the three widgets are DOM and nothing else, and work on a page with
no scene anywhere near them. A page that bundles only them carries none of three.js either: what
they ask of freedom they ask of `justdom-three/page`, which imports none of it, and the package says
it has no side effects, so a bundler leaves the diagnostics out of a page that does not use them.
`src/pageWidgets.test.js` holds the widgets to both: it walks each widget's imports for three.js and
freedom's scene, and it bundles the three from the package's entry with esbuild and fails if
three.js is in the result.

## What is in it

|                                                                                                  |                                                                                                          |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `dropdown(props)`                                                                                | A `<select>` built out of elements, because a real one cannot be mirrored.                               |
| `keyboard(props)`                                                                                | A phone's board, clickable, for typing at a panel you point at — and its number pad, for a number field. |
| `scrollable(props)`                                                                              | A window with arrows, a track and a thumb.                                                               |
| `createDiagnostics()`, `useDiagnostics(ctx, controls)`, `diagnosticsButton(controls, className)` | The frame rate readout, head-locked.                                                                     |

## Nothing here ships colours

Every widget is dressed in class names the caller supplies, one per part. The structure is the
shareable half: a panel's dropdown has to look like that panel, and a library that shipped its own
palette would be fought rather than used. What each class has to _do_ — `position: relative` here,
`overflow: hidden` there, `cursor: pointer` on anything meant to be a ray target — is written down
on the `Classes` typedef beside each widget, because those few are load-bearing rather than
decorative.

## Dropdown

A native `<select>` cannot work in a scene: `<option>` has no CSS box to mirror, and the list the
browser pops up is chrome rather than DOM, so none of it reaches the room. This is one built out of
ordinary elements instead:

```js
import { dropdown } from "justdom-three-ui";

dropdown({
  options: () => outputs.get().map(({ id, name }) => ({ value: id, label: name })),
  selected: () => chosen.get(),
  onSelect: (value) => chosen.set(value),
  classes: { root, trigger, caret, menu, option, optionSelected },
  placeholder: "Choose…",
});
```

Two of those classes carry requirements. `root` is the positioning context (`position: relative`),
and `menu` is a layer (`position: absolute; z-index: 1`) — which in a scene is what pushes the open
menu clear of the surface it covers and gives it a ray blocker of its own, so a ray landing between
two rows stops at the menu rather than pressing a button a few millimetres behind it. See the layers
section of [`freedom`'s README](../three#layers) for what that costs and why. `top: 100%` or
`bottom: 100%` decides which way it opens, and only the panel knows which of the two keeps the menu
over itself rather than hanging into the room.

The menu is mounted when it opens and unmounted when it closes, and it closes on a click anywhere
else in the panel — scoped to the panel through `getPortalRoot`, so the mouse click that is busy
pressing the trigger on the page behind does not also close it. The panel is looked up per click,
not once when the menu opens, so a menu that is open when a portal takes the element it lives in, or
lets it go, is scoped correctly on the next click.

`options` may be a getter, for a list that changes under the player — devices coming and going, a
document being edited — and the open menu follows it.

## Keyboard

The system keyboard cannot reach a panel either, and for a stronger version of the same reason: it
is not even the browser's, it is the compositor's. `keyboard(props)` is a clickable one with a
phone's layout, which is the right one for a board you point at — four rows, no function row, no
arrows, no chording modifiers, every key either typing or changing what the board types next:

```js
import { keyboard } from "justdom-three-ui";

keyboard({
  classes: { root, row, key, keyActive },
  onKey: ({ key, code, shiftKey }) => {
    if (key === "Backspace") {
      text.set(text.get().slice(0, -1));
    } else if (key.length === 1) {
      text.set(text.get() + key);
    }
  },
});
```

Digits and punctuation live behind the `?123` key, exactly as they do on a phone: pressing it turns
every key's symbols face — `q` shows `1`, `a` shows `-` — and `ABC` on the same key reads the way
back. The view is sticky, unlike shift: a view that snapped back after one character would be
re-engaged for every digit of a number. Shift flips each view's faces — `A` over `a`, `!` over `1` —
and stays one-shot, released by the key it modified, because nobody chords on a board they have to
point at. Between the two views and shift, the whole printable ASCII set is never more than two
clicks away, and a test pins that.

A press is shaped like the `KeyboardEvent` it stands in for — `key`, `code`, `shiftKey`, `ctrlKey`,
`altKey`, `metaKey` — plus `capsLock` and `fnKey`, which have nowhere to live on a plain object
otherwise. `code` is the physical key (`"KeyA"`, `"Space"`), and it is also on each element as
`data-code`, which is what to reach for from a test or from an app that wants to light a key up. It
names the position rather than the face: a key showing its symbols face still reports the code it
was built with, exactly as a hardware key reports where it is and not what the layout painted on it
— what it typed is in `key`.

Two things are set from the inside, because they are the layout the caller asked for by name rather
than the dressing: the root and its rows are flex boxes, and each key gets the `flex-grow` its width
unit calls for — 1 for a letter, 1.5 for shift, 5 for the space bar, every row adding up to 10.
Gaps, corners, colours and type are yours; `key` needs a `cursor: pointer` like any other control,
or rays pass straight through the board.

The tree is built once and never changes shape — a state change moves a class name and the text
inside a key. A changed tree costs a re-measure of every box in the panel, and the promise holds for
the symbols view exactly as it holds for shift: flipping the whole board to digits is the same keys
wearing different faces, not a different board.

`MOBILE_LAYOUT` is exported, and `layout` takes any array of rows of `KeyboardKey`, for a game's own
control strip, or a board with one key on it. A custom layout may also use the modifiers the default
one deliberately leaves out — caps lock, ctrl, alt, meta, fn — the machinery is all still there.

### Following the field

A phone's keyboard knows what it is typing into, and a number field gets the number pad rather than
the letters. Hand the board the field and so does this one:

```js
render(Scene, {
  panelOptions: {
    keyboard: {
      create: ({ onKey, field }) => keyboard({ classes, onKey, field }),
    },
  },
});
```

`field` is a getter for the field being typed into, read reactively — the `field` on the target
`freedom`'s keyboard hands its factory is exactly that, and it changes as the typing moves from
panel to panel. A field that asks for digits gets `NUMERIC_LAYOUT`: `<input type="number">`, and any
field whose `inputmode` is `numeric` or `decimal`, which is how a page asks a phone for the pad on a
PIN or a code (`isNumericField` is the test, and is exported). Every other field gets
`MOBILE_LAYOUT`.

`NUMERIC_LAYOUT` is a phone's pad, four keys across: the digits, a minus and a decimal point —
everything a number is written with and nothing a number field would refuse — with backspace, and
`esc` and `enter` bottom left and bottom right, where they are on the letters. `numericLayout`
replaces it; a `layout` given by name is the one board shown whatever the field is.

Switching between the two is the one time the tree is built again: the pad and the letters have no
keys in common to re-label. It happens only as the typing moves between a number field and a text
one, never while typing, and it starts the new board with nothing held — a shift left engaged on the
letters has no key on the pad to be released by.

## Scrollable

In a scene, a list scrolls by itself: `freedom` makes anything that clips its overflow draggable the
moment it has more inside than fits, and pulling it is the direct thing to do with a hand. For a
scrollbar's kind of control — visible, precise, resting — there is `scrollable(props)`, which
supplies arrows, a track and a thumb, built out of ordinary elements like the dropdown:

```js
import { scrollable } from "justdom-three-ui";

scrollable({
  classes: { root, viewport, bar, button, track, thumb, page },
  content: [$("ul", [...])],
  step: 48,
});
```

`viewport` is the window and must hide its overflow — in a scene that is what makes the content
below the fold stop being drawn _and_ stop being a ray target. `bar` holds an arrow at each end of a
`track`, with a `thumb` saying how much of the content is showing and where. An arrow moves `step`
px and keeps moving while it is held; the free track above and below the thumb — the optional `page`
class — jumps a window at a time. The bar is mounted only while there is something to scroll. Make
it chunky: a ray is a blunter instrument than a mouse.

The arrows scroll through `scrollElementBy` rather than by writing `scrollTop`, which matters only
inside an immersive session: the page stops being rendered there, and the `scroll` event goes with
the rendering — so the write goes through, the portal never hears about it, and the thumb slides
down a list that stays where it was. `scrollElementBy` says it itself when the browser is not going
to.

## Diagnostics

Every app here used to mount a `stats.js` panel in the corner of the page, and every one of them
mounted it in the one place it cannot be read. The moment the headset takes the display the page
stops being drawn, so the reading that matters — what the frame rate is _inside the session_, with
the panels and the physics and the soundtrack all running — is the reading nobody can see. The
page's panel measures the desktop preview.

This is the same reading, in the room. Two pieces: an object holding what the readout knows and
whether it is shown, made wherever the scene is built, and an effect that measures and draws it.

```js
import { createDiagnostics, useDiagnostics } from "justdom-three-ui";

const App = effectsOnly((ctx) => {
  const diagnostics = createDiagnostics();

  useEffects(getScene(ctx), [
    effects(() => {
      useDiagnostics(ctx, diagnostics);
    }),
    children(/* the game */),
  ]);
});
```

An effect rather than something to mount, because the panel adds itself to the camera — it is a HUD,
and the camera is already in the scene. So there was never anything for the caller to put anywhere:
this used to be a component whose value was that camera, handed to `use()` so the value could be
dropped again. Call it from any effect, the way `useFrame` is called, and the surrounding
computation owns the meter and the panel both.

`createDiagnostics()` returns the controls:

|            |                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `visible`  | Whether the panel is drawn. Starts true; `createDiagnostics({ visible: false })` starts it hidden. |
| `toggle()` | Shows the panel, or hides it. What a button in the app's own panel calls.                          |
| `fps`      | The current reading, twice a second, or null before there is one.                                  |
| `history`  | The chart: thirty two-second averages, oldest first.                                               |
| `ceiling`  | What full height on the chart means, in fps.                                                       |

The last three are there to be read — by a test, by an app that wants the number somewhere of its
own — and are written by the effect. `diagnosticsButton(controls, className)` is the switch, for an
app's own panel to carry:

```js
diagnosticsButton(diagnostics, actionButton);
```

Only the wording and the wiring are shared; the button wears a class name the app supplies, like
everything else here.

### What it draws

A card about 18 cm across, a metre out, fourteen degrees left of straight ahead and ten above it:
off the middle of the view, where the game is, and inside the arc an eye covers without the neck
helping. On it, a frame rate, and a minute of history as thirty two-second bars. Bars are green
while the display is keeping up, amber where some of the frames are being missed, red where the
scene has become a slideshow — as fractions of the display's own rate, because 72 fps is perfect on
one headset and a quarter of the frames dropped on another.

The panel is deliberately faint — you can read the room through it — and dark enough that the
reading is legible against whatever is behind it. It is an instrument, not part of the game.

Three things about it are worth knowing.

**It lets rays through.** A head-locked panel sits between the player and everything else, so an
opaque one would be a pane of glass their own pointer kept landing on. It is projected through a
portal with `{ opaqueToRays: false }`, which is a `freedom` option this widget is the reason for.

**It draws over the scene rather than in it.** A metre out is where the panel is; it is not where
the game is. A card at arm's length, a board carried up to the face, four white panels filling the
view — anything nearer in the same direction hides it, which is the honest answer for a thing in the
room and the wrong one for an instrument. So the subtree stops testing itself against the depth
buffer and is ordered after everything else. Only depth _testing_ goes: the order the panel draws
itself in is `renderOrder`, and shifting the whole subtree by a constant leaves that exactly as it
was. And only on what draws colour: a material that writes none, such as the depth quad `freedom`
gives a panel drawn in paint order, shows nothing to keep legible and is left as it was made.

**It measures whether or not it is being drawn.** Counting frames is a `+= 1` in a callback the
renderer was making anyway; it is drawing the panel that costs something, and that is what the
switch turns off. A panel switched back on has the last minute to show rather than an empty chart.

### A note for anything that photographs a scene

The reading is a live number and the chart is a minute of live numbers, so a picture of a scene with
this in it never matches the picture before. Anything comparing frames —
[`showcase-xr`](../../apps/showcase-xr)'s visual suite is the one here — should put the panel down
first, through `visible.set(false)` on the controls the app holds. Freezing the clock is not enough:
the timestamps this counts come from the session's frame callbacks rather than from the page's.

### Keeping it cheap

A performance tool that shows up in its own measurements is worth very little, so the panel is built
to cost as close to nothing as a panel in a portal can. Its tree is built once and never changes
shape. The chart's thirty bars are full height and squashed with a `transform` rather than given a
height each, and coloured with an inline `backgroundColor` — both the cheap tier described in
`freedom`'s README: a matrix write and a uniform, with no re-measuring of the panel. Only the
reading itself re-rasterizes, twice a second, and it is given a fixed width so that a two-digit
number and a three-digit one put the unit in the same place.

`createFrameMeter(options)` is the arithmetic on its own — no three.js, no DOM, no signals. It
counts against the timestamps the frame callbacks carry rather than against a wall clock, so a
session that stops being drawn reports the frames it actually got. `chartCeiling(peak)` snaps a
reading to the rate the display is evidently running at (60, 72, 80, 90, 120, 144), which is what
the chart is drawn against. Both are tested in node.

## Development

```
rush build --to justdom-three-ui
```

JavaScript with JSDoc types, checked by `tsc` and shipped as source, like `signal`, `justdom` and
`freedom`; the `.d.ts` files under `lib-types` are generated by `build:types` and are what a
consumer sees.

The widgets are tested against jsdom rather than against a scene, which is the point of building
them out of elements: a dropdown that opens on a page is a dropdown that opens in a room. The one
test that does raise a portal is `keyboard.test.js`, which projects a whole board through a real one
and presses every key by ray — the argument for the whole package, checked.

## Real examples

[`apps/todo-vanilla`](../../apps/todo-vanilla) scrolls its list with `scrollable` on the page and in
the headset alike, and dresses the keyboard freedom's portal offers its text field;
[`apps/rubik`](../../apps/rubik), [`apps/castle-xr`](../../apps/castle-xr),
[`apps/marblerun`](../../apps/marblerun) and the rest of the headset apps pick an audio output with
the dropdown and carry the diagnostics button in their own panels.

## License

MIT — see [LICENSE](../../LICENSE).
