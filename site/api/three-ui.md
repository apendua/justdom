# justdom-three-ui

The widgets a panel is made of, for panels that have to work in a room as well as on a page: a
dropdown, a keyboard, a scrolling window with a bar, and the frame rate readout every headset app in
the demos wears.

All of it is ordinary DOM. [`justdom`](./justdom) builds the trees and [`justdom-signal`](./signal)
keeps them current, which is what lets the same widget be a control on a flat page and a control in
a scene: a [`justdom-three`](./three/) portal mirrors elements, so anything built out of elements
can be pointed at with a ray.

```
npm install justdom-three-ui justdom-three justdom justdom-signal three
```

`justdom-three`, `justdom`, `justdom-signal` and `three` are peer dependencies. Only the diagnostics
panel reaches for three.js; the three widgets are DOM and nothing else, and work on a page with no
scene anywhere near them. A page that bundles only them carries none of three.js either: what they
ask of `justdom-three` they ask of `justdom-three/page`, which imports none of it, and the package
says it has no side effects, so a bundler leaves the diagnostics out of a page that does not use
them. `src/pageWidgets.test.js` holds the widgets to both.

## Nothing here ships colours

Every widget is dressed in class names the caller supplies, one per part, each a source of a class
name such as `className` or `stylesheet` returns. The structure is the shareable half: a panel's
dropdown has to look like that panel. What each class has to _do_, `position: relative` here,
`overflow: hidden` there, `cursor: pointer` on anything meant to be a ray target, is on the
`Classes` typedef beside each widget and listed below, because those few are load-bearing rather
than decorative.

## Dropdown

A native `<select>` cannot work in a scene: `<option>` has no CSS box to mirror, and the list the
browser pops up is chrome rather than DOM. `dropdown(props)` is one built out of ordinary elements:

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

| Prop          | What it is                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `options`     | An array of `{ value, label }`, or a getter of one, read reactively: the open menu follows a list that changes under the player. |
| `selected`    | A getter of the chosen value, read reactively.                                                                                   |
| `onSelect`    | Called with the value of the row pressed.                                                                                        |
| `classes`     | See below.                                                                                                                       |
| `placeholder` | Shown on the trigger when nothing in `options` is selected.                                                                      |
| `caretMarks`  | What the caret says when the menu is open and when it is shut; `["▲", "▼"]` by default.                                          |

| Class            | Requirement                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`           | The positioning context the menu is placed against: `position: relative`.                                                                                                                                      |
| `trigger`        | The closed control, naming whatever is chosen. Needs `cursor: pointer` to be a ray target.                                                                                                                     |
| `caret`          | Optional. The open/closed mark.                                                                                                                                                                                |
| `menu`           | The list. Must be positioned and stacked above, `position: absolute; z-index: 1`, and out of the flow, or opening it resizes the panel it hangs off. `top: 100%` or `bottom: 100%` decides which way it opens. |
| `option`         | One row.                                                                                                                                                                                                       |
| `optionSelected` | Optional. Added to the row that is chosen.                                                                                                                                                                     |

In a scene the `menu` class is what pushes the open menu clear of the surface it covers and gives it
a ray blocker of its own, so a ray landing between two rows stops at the menu rather than pressing a
button a few millimetres behind it; [Paint order](./three/css#paint-order) says what that costs and
why. The menu is mounted when it opens and unmounted when it closes, and it closes on a click
anywhere else in the panel, scoped to the panel through `getPortalRoot`, so the mouse click that is
busy pressing the trigger on the page behind does not also close it. The panel is looked up per
click, not once when the menu opens.

## Keyboard

The system keyboard cannot reach a panel either: it is not even the browser's, it is the
compositor's. `keyboard(props)` is a clickable one with a phone's layout, which is the right one for
a board you point at: four rows, no function row, no arrows, no chording modifiers, every key either
typing or changing what the board types next.

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

| Prop            | What it is                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onKey`         | Called with a `KeyPress` for every key that types something. Modifiers are not reported; they arrive as flags on the press that follows.                                                               |
| `classes`       | `root`, the whole board; `row`, one row; `key`, one key, which needs `cursor: pointer` to be a ray target; `keyActive`, optional, added to a modifier key while it is engaged.                         |
| `layout`        | The one layout the board always shows, as an array of rows of `KeyboardKey`. `MOBILE_LAYOUT` by default, or whichever of `MOBILE_LAYOUT` and `numericLayout` the field asks for when `field` is given. |
| `field`         | A getter of the field being typed into, read reactively. The `field` on the target `justdom-three` hands a board's factory is exactly this. Ignored when `layout` is given.                            |
| `numericLayout` | What a numeric field gets. `NUMERIC_LAYOUT` by default.                                                                                                                                                |

A `KeyPress` is shaped like the `KeyboardEvent` it stands in for: `key`, `code`, `shiftKey`,
`ctrlKey`, `altKey`, `metaKey`, plus `capsLock` and `fnKey`. `code` is the physical key, `"KeyA"`,
`"Space"`, and is also on each key's element as `data-code`, which is what a test or an app that
lights a key up reaches for; it names the position, not the face, so a key showing its symbols face
still reports the code it was built with.

- Digits and punctuation live behind the `?123` key, as on a phone: pressing it turns every key's
  symbols face, and `ABC` on the same key reads the way back. The view is sticky, unlike shift.
  Shift flips each view's faces and stays one-shot, released by the key it modified. Between the two
  views and shift, the whole printable ASCII set is never more than two clicks away, and a test pins
  that.
- The root and its rows are flex boxes, and each key gets the `flex-grow` its width calls for: 1 for
  a letter, 1.5 for shift, backspace and enter, 5 for the space bar, every row adding up to 10.
  Gaps, corners, colours and type are the caller's.
- The tree is built once and never changes shape: a state change moves a class name and the text
  inside a key. Switching between the letters and the number pad is the one time the tree is built
  again, since the two have no keys in common, and it happens only as the typing moves between a
  number field and a text one, starting the new board with nothing held.
- `MOBILE_LAYOUT` and `NUMERIC_LAYOUT` are exported, and a custom layout may use the modifiers the
  default one leaves out: caps lock, ctrl, alt, meta, fn.

### Following the field

Given `field`, the board follows the field being typed into the way a phone's keyboard does: a field
that asks for digits gets `NUMERIC_LAYOUT`, which is `<input type="number">` and any field whose
`inputmode` is `numeric` or `decimal`; `isNumericField(input)` is that test, exported. Every other
field gets `MOBILE_LAYOUT`. `NUMERIC_LAYOUT` is a phone's pad, four keys across: the digits, a minus
and a decimal point, with backspace, and `esc` and `enter` bottom left and bottom right.

```js
render(Scene, {
  panelOptions: {
    keyboard: {
      create: ({ onKey, field }) => keyboard({ classes, onKey, field }),
    },
  },
});
```

## Scrollable

In a scene, a list scrolls by itself: `justdom-three` makes anything that clips its overflow
draggable the moment it has more inside than fits. For a scrollbar's kind of control, visible,
precise, resting, there is `scrollable(props)`: arrows, a track and a thumb, built out of ordinary
elements like the dropdown.

```js
import { scrollable } from "justdom-three-ui";

scrollable({
  classes: { root, viewport, bar, button, track, thumb, page },
  content: [$("ul", [...])],
  step: 48,
});
```

| Prop             | What it is                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `classes`        | See below.                                                                                                        |
| `content`        | The sources being scrolled, as `children` takes them.                                                             |
| `step`           | How far one press of an arrow moves the content, in px. A row's height is the number to reach for. 48 by default. |
| `marks`          | What the arrows say; `["▲", "▼"]` by default.                                                                     |
| `repeatDelay`    | How long an arrow must be held before it starts repeating, in ms.                                                 |
| `repeatInterval` | How often it repeats after that.                                                                                  |

| Class      | Requirement                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `root`     | Content and bar side by side: `display: flex` and a height.                                                                                |
| `viewport` | The window. Must hide its overflow; in a scene that is what makes the content below the fold stop being drawn and stop being a ray target. |
| `bar`      | The column the controls live in. Mounted only while there is something to scroll.                                                          |
| `button`   | An arrow. Needs `cursor: pointer`.                                                                                                         |
| `track`    | What the thumb slides in: `position: relative`, and tall enough to be worth pointing at.                                                   |
| `thumb`    | Positioned absolutely; `top` and `height` are written onto it as percentages of the track.                                                 |
| `page`     | Optional. The free track above and below the thumb, which jumps a window at a time. Positioned absolutely, and `cursor: pointer`.          |

The arrows scroll through `scrollElementBy` rather than by writing `scrollTop`, which matters only
inside an immersive session: the page stops being rendered there, and the `scroll` event goes with
the rendering, so the write would go through, the portal would never hear about it, and the thumb
would slide down a list that stays where it was. Make the controls chunky: a ray is a blunter
instrument than a mouse.

## Diagnostics

A frame rate panel in the corner of the page measures the desktop preview, and the moment the
headset takes the display the page stops being drawn. This is the same reading, in the room. Two
pieces: an object holding what the readout knows and whether it is shown, and an effect that
measures and draws it.

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

`useDiagnostics(ctx, controls)` is an effect rather than something to mount because the panel adds
itself to the camera, which is already in the scene. Call it from any effect, the way `useFrame` is
called, and the surrounding computation owns the meter and the panel both.

`createDiagnostics(options?)` returns the controls; `{ visible: false }` starts the panel hidden.

| Control    | What it is                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `visible`  | A `Signal<boolean>`: whether the panel is drawn. Readings are taken either way, so a panel switched back on has the last minute to show. |
| `toggle()` | Shows the panel, or hides it. What a button in the app's own panel calls.                                                                |
| `fps`      | A `Signal<number \| null>`: the reading, twice a second, or null before there is one.                                                    |
| `history`  | A `Signal<readonly number[]>`: the chart, thirty two-second averages, oldest first.                                                      |
| `ceiling`  | A `Signal<number>`: what full height on the chart means, in fps.                                                                         |

`diagnosticsButton(controls, className)` is the switch, for an app's own panel to carry: only the
wording and the wiring are shared, and it wears the class name the app supplies.

### What it draws

A card a metre out, fourteen degrees left of straight ahead and ten above it: off the middle of the
view, where the game is, and inside the arc an eye covers without the neck helping. On it, a frame
rate, and a minute of history as thirty two-second bars, coloured as fractions of the display's own
rate, since 72 fps is perfect on one headset and a quarter of the frames dropped on another. The
panel is faint, so the room can be read through it, and dark enough that the reading is legible.

- **It lets rays through.** It is projected through a portal with `{ opaqueToRays: false }`, the
  option this widget is the reason for.
- **It draws over the scene rather than in it.** Anything nearer in the same direction would hide
  it, which is the honest answer for a thing in the room and the wrong one for an instrument, so the
  subtree stops testing itself against the depth buffer and is ordered after everything else. Only
  on what draws colour: the depth quad a panel drawn in paint order carries is left as it was made.
- **It measures whether or not it is being drawn.** Counting frames is a `+= 1` in a callback the
  renderer was making anyway; drawing the panel is what costs something, and that is what the switch
  turns off.

Anything comparing photographs of a scene should put the panel down first, through
`visible.set(false)`: the reading is a live number, and freezing the clock is not enough, since the
timestamps it counts come from the session's frame callbacks rather than from the page's.

### Keeping it cheap

The panel's tree is built once and never changes shape. The chart's thirty bars are full height and
squashed with a `transform` rather than given a height each, and coloured with an inline
`backgroundColor`: a matrix write and a uniform, with no re-measuring of the panel. Only the reading
re-rasterizes, twice a second, in a fixed width so that a two-digit number and a three-digit one put
the unit in the same place.

`createFrameMeter(options)` is the arithmetic on its own, with no three.js, no DOM and no signals.
It counts against the timestamps the frame callbacks carry rather than a wall clock, so a session
that stops being drawn reports the frames it got. `chartCeiling(peak)` snaps a reading to the rate
the display is evidently running at (60, 72, 80, 90, 120, 144). `READOUT_MS` (500), `SAMPLE_MS`
(2000) and `SAMPLE_COUNT` (30) are the readout's period, a bar's width in time and the chart's
length.

## Real examples

[`apps/todo`](https://github.com/apendua/justdom/tree/develop/apps/todo) scrolls its list with
`scrollable` on the page and in the headset alike, and dresses the keyboard the portal offers its
text field; [`apps/castle`](https://github.com/apendua/justdom/tree/develop/apps/castle) picks an
audio output with the dropdown and carries the diagnostics button in its own panel;
[`apps/euclid`](https://github.com/apendua/justdom/tree/develop/apps/euclid)'s toolbar uses the
dropdown too.
