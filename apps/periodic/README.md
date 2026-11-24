# Periodic Table

The 118 elements in Mendeleev's arrangement, with four ways to colour them: by category, by state at
a temperature you set, by electronegativity, and by the year each was discovered, with the gaps
Mendeleev left in 1869 and 1871 shown as the elements he predicted, under the names he gave them
in 1871. Point at a tile and a popup comes up over it while the panel above the transition metals
shows the element in full, with a Bohr model of its shells. In a headset it is the same DOM,
mirrored into one panel, without the popup, and the atom of the element under the ray turns in three
dimensions beside the table.

## Running it

```
npm run dev        # http://localhost:5173/demos/periodic/
npm run build      # what `rush build` runs
```

On a laptop the page is all there is: no session can be opened, so no Enter button is shown and
three.js is never fetched, not even by the service worker. `?emulator` installs a headset in the
browser (IWER, with its dev panels) and the **Enter** button appears at the bottom; `?emulator=bare`
installs the runtime without the panels. `?touch` installs it with `justdom-xr`'s touch layer
instead, for a phone: a drag turns the head, a tap on a tile pins it, and two fingers pinch the view
in and out. On a phone `?emulator` installs the touch layer too.

`node tests/xr-check.mjs` first builds the app for production and fails unless its service worker
precaches exactly the JS the page loads. It then loads the page alone in headless Chromium, which
can present nothing, and fails if the headset scene is fetched. Then it plays a session on the
emulated headset: it points the ray at iron's tile and checks that the inspector shows iron, that no
popup comes up and that nothing on the table has a transition to run, pins it with the trigger,
presses Discovery and the 1869 chip and checks that the table counts 63 known elements with
gallium's tile a predicted gap, and leaves by the ×. Last it enters and leaves a second session and
fails if the renderer then holds more geometries than after the first. `SHOTS=<dir>` also
photographs the page and the session, and `STACKS=1` prints a stack for anything the page throws. It
drives the browser and the controller through `justdom-xr/driver`; `CHROMIUM=<path>` points it at a
Chromium other than the one it looks for. A pull request that changes this app or a package it
imports runs it, with the other apps' checks, from `.github/workflows/driven.yml`.

## How it is put together

| File                      | What it is                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/data/elements.ts`    | The elements, one line of figures each, and where each sits in the table. The electron shells are worked out from the configuration, so the two cannot disagree.            |
| `src/looks.ts`            | How a tile is coloured in each view: a plain function of the element and the view's settings, shared by the tiles, the popup, the inspector, the legend and the atom.       |
| `src/facts.ts`            | How the popup and the inspector write a figure: units, blanks and the one-line notes.                                                                                       |
| `src/store/TableState.ts` | The one store the page and the headset read: the view and its setting, the element under the pointer and the one pinned.                                                    |
| `src/store/pointer.ts`    | Where the pointer is: `hovered` at once, and `inspected`, which the inspector and the atom show, once a ray has settled.                                                    |
| `src/store/player.ts`     | The discovery view's Play: one timer that steps the year, more slowly in a session, which every control stops.                                                              |
| `src/components/`         | The table (`PeriodicTable`), its tiles, the popup, the inspector with its Bohr model, the header with the views and their sliders, and the legend.                          |
| `src/xr.ts`               | The session: makes the renderer with the controller and hand models from `justdom-xr`'s `inputModels()`, and the Enter button.                                              |
| `src/components/Scene.ts` | The scene: the panel, a backdrop, lights, the cursors, the frame rate and the atom.                                                                                         |
| `src/components/Atom.ts`  | The atom in three dimensions: nucleons as one instanced mesh, electrons as another, running round tilted shells. Everything is made once, and a frame only writes matrices. |
| `src/placement.ts`        | Where the panel and the atom stand, in plain numbers, shared with `tests/xr-check.mjs`.                                                                                     |

The table is one element, so a session mirrors it into one panel, and everything on it reaches the
headset the way it reaches the mouse. A tile is a `<button>`: its `pointerenter` sets the hovered
element through `src/store/pointer.ts`, which mounts the popup over it and fills the inspector, and
its `click` pins it. A ray sends the same events, so neither needs to know about the headset. The
tile's `:hover` rule lifts it on the page; in a panel justdom-three rewrites that rule to answer its
ray too, and one more rule, on `[data-xr-hover]`, lifts the tile off the panel towards the viewer
with `translateZ`.

The temperature and year sliders are drawn from `<div>`s rather than `<input type="range">`, so that
a ray can drag them: a press captures the pointer and the moves are read off the track. The
discovery view plays its years on a timer, since the page's animation frames stop while a session
has the display.

The table's narrow layouts are container queries on `#table`, not media queries on the window. On a
phone the columns keep a width a finger can hit and scroll sideways, and the inspector docks at the
bottom of the screen. A session lays `#table` out at a wide window's width on any device, so a
phone's session shows the same table a laptop's does.

A session changes four things, each of which would otherwise be work for the panel on every frame or
every tile the ray crosses:

- the popup is not mounted, since the inspector and the atom show the same element;
- the inspector and the atom follow the ray only once it has rested 150 ms on one tile, so a sweep
  across the table rebuilds them once, where it ends;
- nothing on the card has a CSS transition, so a change of view lands in one step rather than as
  half a second of fades on 118 tiles;
- Play steps 5 years four times a second, not 2 years every 60 ms;

and the Bohr model in the inspector stops turning, since the atom beside the table shows the same
shells, and a panel with nothing animating costs nothing a frame. The figures are the usual
reference values, rounded; `src/data/elements.ts` says which are predicted and how a blank is
written.
