# Todo App

Everyone's first app, written once. On a page it is plain DOM wired to signals — components are
functions, updates land as attribute and text writes, there is no framework underneath. On a headset
it is the very same DOM: the page keeps showing it, and `justdom-three` mirrors the element the app
is mounted in into a panel in front of the viewer, keyboard and all.

There used to be two apps here — `todo-vanilla` for the page and `todo-xr` for the headset, each
building the list from the same components. This is what replaced them, and the point of it: an app
that already delivers a flat interface adds an immersive session without building its UI twice.

## Running it

```
npm run dev        # http://localhost:5173
npm run build      # what `rush build` runs
```

The dev server is plain http on localhost, which browsers treat as a secure origin, so WebXR (and
the emulator) work there. Serving it to a headset over the local network would need https and is not
set up.

On a laptop the page is the page and nothing else: no session can be opened, so no button is shown,
no renderer is made and three.js is never fetched, not even by the service worker, which leaves the
headset's chunks out of its precache. The controller and hand models come from three's default CDN,
so a session needs the network. `node tests/drag-check.mjs` builds the app for production first and
fails unless its service worker precaches exactly the JS the page loads. `?emulator` installs a
headset in the browser (IWER, with its dev panels) and the **Enter VR** button appears at the
bottom; press it and the emulated session is drawn over the page, driven from the panels.
`?emulator=bare` installs the runtime without the panels, for a harness photographing the scene.

## How it is put together

| File                             | What it is                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                    | Mounts `TodoApp` into `#root`, then offers a session that mirrors `#root`, through `justdom-xr`'s `offerHeadset`, which loads `xr.ts` only on a platform that can present.                                                                                                                                          |
| `src/xr.ts`                      | The session: makes the renderer with the controller and hand models from `justdom-xr`'s `inputModels()`, and the Enter button, and shows the canvas only while a session runs. Hands `render()` the keyboard as a panel option.                                                                                     |
| `src/components/TodoApp.ts`      | The app, written for the page: a field, an Add button, a count, and the list behind `scrollable` from `justdom-three-ui`, reordered by dragging.                                                                                                                                                                    |
| `src/components/TodoItem.ts`     | A row: a drag handle, a checkbox drawn honestly in both builds, a label, a Delete button.                                                                                                                                                                                                                           |
| `tests/drag-check.mjs`           | Reorders the list by dragging, with the mouse on the page and with the controller in the emulator.                                                                                                                                                                                                                  |
| `src/focusDiagnostics.ts`        | Under `?keylog`, a log in the card of keys, focus and the system keyboard, to read in a headset.                                                                                                                                                                                                                    |
| `src/components/Scene.ts`        | The scene: `dom(ctx, panel, …)`. A backdrop, lights, a cursor, the panel, and the frame rate while a session runs.                                                                                                                                                                                                  |
| `src/components/TodoKeyboard.ts` | What the headset's keyboard looks like: `keyboard` from `justdom-three-ui` dressed for this panel.                                                                                                                                                                                                                  |
| `justdom-xr`                     | Not a file here, but shared with the other headset apps: IWER behind `?emulator` and the offer of a session; `canPresent`; `xrSession`, the session the page is shown in, written by the scene and read by the app for its exit button; the backdrop; and the controller and hand models, from three's default CDN. |

Three things the page does not know about, and does not need to.

**The field is a real `<input>`.** On the page the browser draws the caret and takes the keys. In
the scene freedom draws the value, the placeholder and a caret, and the keyboard it opens in front
of the viewer types through the same `input` and `keydown` events the page's handlers already listen
for, so `Enter` adds a todo in both. Clearing the field after a submit is a plain `value` write,
which the mirror follows. `[data-xr-focus]` is the scene's `:focus`.

**The list scrolls on both.** `scrollable` is made of ordinary elements — a viewport that hides its
overflow, arrows, a track and a thumb — so it works on the page as a list with its own scrollbar,
and in the scene as a window the portal clips to, rows below the fold neither drawn nor pressable.
Rows can also be grabbed and pulled with the trigger.

**The rows can be reordered by dragging.** Each row has a handle at its left, `draggable="true"`,
and the list listens for the browser's drag and drop: `dragstart` on the handle says which todo is
carried and fades its row, `dragover` turns the divider above the slot it would land in blue, and
`drop` moves it. On the page that is a mouse drag. In a session it is the trigger closed on the
handle, the ray carried down the list and the trigger opened, and freedom turns that into the same
events, so the same handlers run. The marks are plain CSS, an `opacity` and a border colour, set by
classes. `node tests/drag-check.mjs` does both, the mouse on the page and the controller in the
emulator, and prints the events and the order the todos ended up in; `SHOT=drag.png` photographs the
drag half way.

**Two things are there only in a session.** The frame rate, from justui's `useDiagnostics`, hangs in
the upper left of the view. And the card grows an exit button in its top-right corner, an ordinary
`<button>` hidden on the page, which ends the session when pressed. The app cannot ask the renderer
whether there is a session, since it is mounted before there is one, so the scene tells it: it
copies `getXRSession(ctx)` into `xrSession`, and the button's `hidden` follows that.

**Nothing runs until a session does.** The renderer is made with `presentingOnly`, so no frame is
drawn and no frame callback runs between sessions, and the panel is mounted when a session starts
and taken down when it ends: a visitor who never presses Enter pays for a button and nothing else,
and the page is never mirrored into a scene nobody is looking at. The session is set against one
dark colour all the way round — an opaque sphere around the viewer, since in AR three clears to the
passthrough whatever the scene's background says.

**The keyboard is the scene's to place.** `TodoKeyboard` says what a key looks like, and `xr.ts`
hands it to `render()` as a panel option, so every panel in the scene gets it without asking. When
the board appears, where it opens, what a key does to the field and when the board goes are decided
by freedom. Press the field and it opens in front of you, below eye level and reclined toward the
hands; point at it and handles show along its edges to move it by. `xr.ts` sets three things about
it: the board is three quarters of freedom's default size, it reclines 34° so that its face looks at
the eyes, and the copy of the field above the keys lies in the keys' plane. It behaves like focus on
the page: `Enter` adds the todo and keeps the field, so the next one can be typed straight in, while
pressing Add, or anything else in the card, puts the keyboard away as a click would blur the field.
`Escape` puts it away too.

## The key log

`?keylog` puts a log at the bottom of the card, `src/focusDiagnostics.ts`, to read in a headset,
where there are no dev tools. It shows whether `navigator.virtualKeyboard` exists and the rectangle
its `geometrychange` reports, every `keydown` with whether the browser sent it (`TRUSTED`) or a
script did (freedom's keyboard), focus moving in the card, and the window and the visual viewport
changing size. It is there to answer the first question in #547: whether a keyboard paired with a
Quest sends its keys to the page during a session while nothing on the page has focus.

A ray's press on the field is a click freedom dispatches itself, which moves no focus, so in a
session the field never has the page's focus. Giving it that focus (`?realfocus`, #527) was tried
and taken out: on a Quest it brings up the system keyboard, whose caret stays at the start of the
word, whose Enter always closes it, and which leaves the scene unresponsive while it is up.
