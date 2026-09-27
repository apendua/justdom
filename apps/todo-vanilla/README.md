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
npm run dev        # https://localhost:5173, from vite's basic-ssl plugin
npm run build      # what `rush build` runs
```

The dev server is https because WebXR is only offered on a secure origin; a
headset on the same network opens it by IP and accepts the certificate once.

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
| `src/xr.ts` | The offer: checks the platform can present, makes the renderer and the Enter button, shows the canvas only while a session runs. |
| `src/components/TodoApp.ts` | The app, written for the page: a field, an Add button, a count, and the list behind `scrollable` from `@apendua/justui`. |
| `src/components/TodoItem.ts` | A row: a checkbox drawn honestly in both builds, a label, a Delete button. |
| `src/components/Scene.ts` | The scene: `dom(ctx, panel, …, { keyboard })`. Lights, a cursor, and the panel. |
| `src/components/TodoKeyboard.ts` | What the headset's keyboard looks like: `keyboard` from `@apendua/justui` dressed for this panel. |
| `src/emulator.ts` | IWER, behind `?emulator`. |

Three things the page does not know about, and does not need to.

**The field is a real `<input>`.** On the page the browser draws the caret
and takes the keys. In the scene freedom draws the value, the placeholder and
a caret, and the keyboard it mounts under the panel types through the same
`input` and `keydown` events the page's handlers already listen for, so
`Enter` adds a todo in both. Clearing the field after a submit is a plain
`value` write, which the mirror follows. `[data-xr-focus]` is the scene's
`:focus`.

**The list scrolls on both.** `scrollable` is made of ordinary elements — a
viewport that hides its overflow, arrows, a track and a thumb — so it works
on the page as a list with its own scrollbar, and in the scene as a window the
portal clips to, rows below the fold neither drawn nor pressable. Rows can
also be grabbed and pulled with the trigger.

**Nothing runs until a session does.** The renderer is made with
`presentingOnly`, so no frame is drawn and no frame callback runs between
sessions, and the panel is mounted when a session starts and taken down when
it ends: a visitor who never presses Enter pays for a button and nothing
else, and the page is never mirrored into a scene nobody is looking at. The
session is set against one dark colour all the way round — an opaque sphere
around the viewer, since in AR three clears to the passthrough whatever the
scene's background says.

**The keyboard is the portal's to place.** `TodoKeyboard` says what a key
looks like; when the board appears, where it hangs, what a key does to the
field and when the board goes are decided by freedom, the same way for every
panel given a `keyboard`. Press the field and it swings out below the panel,
reclined toward the hands; `Enter`, `Escape` or a press on the panel's
background puts it away.
