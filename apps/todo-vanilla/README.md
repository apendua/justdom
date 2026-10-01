# Todo App

Everyone's first app, written once. On a page it is plain DOM wired to
signals — components are functions, updates land as attribute and text
writes, there is no framework underneath. On a headset it is the very same
DOM: the page keeps showing it, and `@apendua/freedom` mirrors the element
the app is mounted in into a panel in front of the viewer, keyboard and all.

There used to be two apps here — `todo-vanilla` for the page and `todo-xr`
for the headset, each building the list from the same components. This is
what replaced them, and the point of it: an app that already delivers a flat
interface adds an immersive session without building its UI twice.

## Running it

```
npm run dev        # http://localhost:5173
npm run build      # what `rush build` runs
```

The dev server is plain http on localhost, which browsers treat as a secure
origin, so WebXR (and the emulator) work there. Serving it to a headset over the
local network would need https and is not set up.

On a laptop the page is the page and nothing else: no session can be opened,
so no button is shown and no renderer is made. `?emulator` installs a headset
in the browser (IWER, with its dev panels) and the **Enter VR** button
appears at the bottom; press it and the emulated session is drawn over the
page, driven from the panels. `?emulator=bare` installs the runtime without
the panels, for a harness photographing the scene.

## How it is put together

| File | What it is |
| --- | --- |
| `src/main.ts` | Mounts `TodoApp` into `#root`, then offers a session that mirrors `#root`. |
| `src/xr.ts` | The offer: checks the platform can present, makes the renderer and the Enter button, shows the canvas only while a session runs. Hands `render()` the keyboard as a panel option. |
| `src/components/TodoApp.ts` | The app, written for the page: a field, an Add button, a count, and the list behind `scrollable` from `@apendua/justui`, reordered by dragging. |
| `src/components/TodoItem.ts` | A row: a drag handle, a checkbox drawn honestly in both builds, a label, a Delete button. |
| `tests/drag-check.mjs` | Reorders the list by dragging, with the mouse on the page and with the controller in the emulator. |
| `src/components/Scene.ts` | The scene: `dom(ctx, panel, …)`. Lights, a cursor, the panel, and the frame rate while a session runs. |
| `src/session.ts` | The session the page is shown in, or null: written by the scene from `getXRSession`, read by the app for its exit button. |
| `src/components/TodoKeyboard.ts` | What the headset's keyboard looks like: `keyboard` from `@apendua/justui` dressed for this panel. |
| `src/emulator.ts` | IWER, behind `?emulator`. |

Three things the page does not know about, and does not need to.

**The field is a real `<input>`.** On the page the browser draws the caret
and takes the keys. In the scene freedom draws the value, the placeholder and
a caret, and the keyboard it opens in front of the viewer types through the same
`input` and `keydown` events the page's handlers already listen for, so
`Enter` adds a todo in both. Clearing the field after a submit is a plain
`value` write, which the mirror follows. `[data-xr-focus]` is the scene's
`:focus`.

**The list scrolls on both.** `scrollable` is made of ordinary elements — a
viewport that hides its overflow, arrows, a track and a thumb — so it works
on the page as a list with its own scrollbar, and in the scene as a window the
portal clips to, rows below the fold neither drawn nor pressable. Rows can
also be grabbed and pulled with the trigger.

**The rows can be reordered by dragging.** Each row has a handle at its
left, `draggable="true"`, and the list listens for the browser's drag and
drop: `dragstart` on the handle says which todo is carried and fades its
row, `dragover` turns the divider above the slot it would land in blue,
and `drop` moves it. On the
page that is a mouse drag. In a session it is the trigger closed on the
handle, the ray carried down the list and the trigger opened, and freedom
turns that into the same events, so the same handlers run. The marks are
plain CSS, an `opacity` and a border colour, set by classes rather than
data attributes because a class is what the panel follows. `node tests/drag-check.mjs` does both, the mouse on the page and
the controller in the emulator, and prints the events and the order the
todos ended up in; `SHOT=drag.png` photographs the drag half way.

**Two things are there only in a session.** The frame rate, from justui's
`useDiagnostics`, hangs in the upper left of the view. And the card grows an
exit button in its top-right corner, an ordinary `<button>` hidden on the
page, which ends the session when pressed. The app cannot ask the renderer
whether there is a session, since it is mounted before there is one, so the
scene tells it: it copies `getXRSession(ctx)` into `xrSession`, and the
button's `hidden` follows that.

**Nothing runs until a session does.** The renderer is made with
`presentingOnly`, so no frame is drawn and no frame callback runs between
sessions, and the panel is mounted when a session starts and taken down when
it ends: a visitor who never presses Enter pays for a button and nothing
else, and the page is never mirrored into a scene nobody is looking at. The
session is set against one dark colour all the way round — an opaque sphere
around the viewer, since in AR three clears to the passthrough whatever the
scene's background says.

**The keyboard is the scene's to place.** `TodoKeyboard` says what a key
looks like, and `xr.ts` hands it to `render()` as a panel option, so every
panel in the scene gets it without asking. When the board appears, where it
opens, what a key does to the field and when the board goes are decided by
freedom. Press the field and it opens in front of you, below eye level and
reclined toward the hands; point at it and handles show along its edges to
move it by. It behaves like focus on the page: `Enter` adds the todo and
keeps the field, so the next one can be typed straight in, while pressing
Add, or anything else in the card, puts the keyboard away as a click would
blur the field. `Escape` puts it away too.
