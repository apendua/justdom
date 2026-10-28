# Desk

A desk drawn in HTML and CSS, in three looks: a computer typing out its program on its screen, a
keyboard that types on it, a panel of live charts, a board of cards, something to load programs
from, and a paper to read. On a page it is a page. In a headset `@apendua/freedom` mirrors each
object into a panel of its own and sets them out on a desk in a room.

It is the sampler for what freedom can mirror, written as one scene rather than a grid of specimens.
`apps/showcase-xr` stays as it is, because its visual suite is a regression test for freedom and
needs a scene that holds still. The three looks are the mockups in
[`docs/showcase-desk`](../../docs/showcase-desk), each picked from the "Look" menu in the corner:

| Look          | `?look=` | The desk                                                                                                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Beige Box '84 | `beige`  | A beige computer in green phosphor, an instrument rack, a cork board, floppy disks, a memo on letterhead, a wall clock and a mug.                                         |
| Night Ops     | `ops`    | A control room at night: amber phosphor, needle gauges and a radar, a whiteboard run as a kanban, cassettes, a green-bar printout and three world clocks.                 |
| Paper Studio  | `paper`  | A 1-bit desktop with the terminal in a window, a notebook with tabs, a linen pinboard whose swatches recolour the desk, cartridges, a letter with a wax seal and a plant. |

## Running it

```
npm run dev        # http://localhost:5173/apps/desk/
npm run build      # what `rush build` runs
```

The page needs the network for its fonts, which come from Google Fonts. Each look loads its own.

The page opens on the look its address names, `?look=ops` for example, and on Beige Box '84 without
one. Picking another from the menu swaps it in place and writes it into the address, so a reload or
a link opens the same desk. The menu is hidden while a session runs, which mirrors the look it
started with.

On a laptop there is no session to offer, so there is no button and no renderer. `?emulator`
installs a headset in the browser (IWER, with its dev panels, from `@apendua.dev/headset`) and an
Enter button appears at the bottom; `?emulator=bare` installs the runtime without the panels.

`?depthRank=constant`, `?depthRank=slope` or `?depthRank=max` draws every panel's boxes with
freedom's depth bias by paint rank, a prototype for item 10.2 of
[`docs/freedom-architecture-plan.md`](../../docs/freedom-architecture-plan.md). The plan's record of
the item says what each one measured, and where the probe that measured them last stood.

`?paintOrder=off` draws every panel by the lift rather than in paint order, freedom's default, to
compare the two ([`docs/freedom-paint-order-plan.md`](../../docs/freedom-paint-order-plan.md)).
`?trace`, under the dev server, keeps a row for every frame of each session and saves them as the
session ends (`src/deskTrace.ts`), the paint-order probe's trace (below) taken on the whole desk:
the frame's times, the panels with work for a coming frame, and how far each of the board's cards
has risen in the scene. `?trace=page` reads how far each has risen on the page as well, which can
change what it measures. The console says where the file went.

`node tests/xr-check.mjs` puts each look up in turn in a session on the emulated headset in headless
Chromium. It fails unless every zone the look places becomes a panel and loads, the ray aimed at the
power control is on it, and the trigger there ends the session, or if the page throws. For the first
look it then starts a second session and fails if ending it leaves more geometries on the GPU than
the first did. It takes about two minutes. `SHOTS=<dir>` also photographs each session, and
`STACKS=1` prints a stack for anything the page throws. `PAINT_ORDER=0` runs it on panels drawn by
the lift (`?paintOrder=off`), for `docs/freedom-paint-order-plan.md`. It drives the browser and the
controller through `@apendua.dev/headset/driver`, which borrows Playwright from `apps/showcase-xr`
and launches the Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; `CHROMIUM=<path>`
points it at one installed elsewhere. A pull request that changes this app or a package it imports,
other than in docs, unit tests or benchmarks, runs it, with minesweeper's, Euclid's and Knights',
from `.github/workflows/driven.yml`.

## The paint-order probe

`paint-order-probe.html` is the page the Quest's half of phase 4 in
[`docs/freedom-paint-order-plan.md`](../../docs/freedom-paint-order-plan.md) was measured on, and it
stays to measure a panel drawn in paint order on the headset. It is served by the dev server alone:
`vite build` builds `index.html` and nothing else. On a Quest, over USB:

```
npx vite                           # in apps/desk
adb reverse tcp:5173 tcp:5173      # the headset's localhost:5173 is this machine's
```

then open `http://localhost:5173/apps/desk/paint-order-probe.html?scene=pile` in the Quest Browser
for the paint-order build, and the same with `&paintOrder=off` for the lift's. `localhost` is a
secure context, so the session needs no certificate. `?emulator` runs it under IWER on a desktop
instead.

`?scene=` picks one of nine scenes, so that what a measurement draws is that scene and nothing else:
`pile`, the 100-card piled board; `mount`, a panel holding a swung card, mounted mid-session;
`flip`, a card inside a swung card flipped by a transition; `third`, a third level swung in a panel
mounted with nothing swung; `tilts`, cards 2° and 5° from their panel on an opaque root and in a
translucent overlay, whose Action raises the sibling over each card's near half 3 px, so that the
card passes through it; `piles`, labelled piles in 10.1's poses at 1, 5 and 10 m; `flip90`, a card
turning, frozen edge-on; `hover`, Beige Box's corkboard notes, made from its note template and drawn
by its stylesheet and fonts, which rise when the ray is on them; and `cross`, two panels crossing
through their middles, one turned 35°, each half of one in front of the other. A control panel, on
the page and low to the left in the session, has the scene's Action button, which records the
session's frames for 2.5 s from the frame it acts in: their intervals against the frame budget and
the programs linked meanwhile. In `mount` it mounts the panel once a page, and a second mount takes
a reload. Record 5 s, in every scene, records the session's frames for 5 s with nothing done to the
scene, for what the person in the headset does meanwhile, such as moving the ray over `hover`'s
notes. Each run also keeps a row for each frame (`src/probe/trace.ts`): how long the frame's
callbacks and its draw took, and how long since the page itself was last rendered, which the Quest
stops doing in a session. In `hover`, each row also has the notes that are moving: how far each has
risen on the page and in the scene, and the animations running on it. That shows whether a note that
stops for a moment as the ray comes was a slow frame or a note that did not move. Reading the page
makes it update its styles every frame, which a page the Quest no longer renders would not do, so
`&trace=scene` leaves the page alone and records the scene's side only. Neither button takes a press
while a run records, whichever button started it. Capture eyes reads both eyes' images back from one
frame. Save JSON sends what the probe found to the dev server, which writes it to
`probe-results/paint-order-probe-<scene>-<build>-<time>.json` in this app's directory, `<build>`
being `lift` or `paint-order` (`vite/probeResults.js`, development only, and in `.gitignore`), so a
run on the headset lands on the machine it is plugged into. A button that fails says why on the
control panel's status line.

## What you can do

- Type on your own keyboard, or click the keys. The monitor takes commands at its prompt; `HELP`
  lists them.
- Drag a floppy, cassette or cartridge onto the drive, deck or slot under the screen to load what is
  on it.
- Change the screen's colour from the phosphor control: the PHOSPHOR or AMBER button under the
  screen, or the desktop's Terminal menu.
- Beige Box '84: drag the cards about the board. The pink card's field pins a new note on Enter;
  while the field has focus the desk's keyboard types into it.
- Night Ops: drag tickets between the whiteboard's columns. A ticket lands above or below the others
  by where it is let go.
- Paper Studio: the notebook's tabs change its page, the swatches on the pinboard recolour the whole
  desk, and the scrap of paper on the pinboard takes notes as the pink card does.
- "Feature notes", top left, labels each object with what it exercises.

In a session the same things work with a controller's trigger or a pinch: the keys are pressed with
the ray, the floppies are dragged from their panel onto the monitor's, and the board's field opens a
keyboard of its own in front of you, since the desk's keyboard is the monitor's. A keyboard on the
laptop or paired with the headset types on the monitor too, since the field never has the page's
focus in a session (#547). The charts, the board and the memo can be picked up by their edges; the
memo takes the hand's whole rotation, so it can be tipped up to read. The power button under the
screen ends the session; on Night Ops it is PWR, and on Paper Studio the terminal window's close
box.

## How it is put together

Each look is its markup and its stylesheet in `src/looks/`, and an entry in `src/looks.ts` that says
how a session sets it out. `src/index.css` holds what every look shares: the page's chrome and the
rules for a session. Each object is a `.zone` with an id, and the modules in `src/` make them move:

| File                             | What it is                                                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                    | Puts up the look the address names, runs the menu that swaps it, and offers a session.                                                                                                                                                                          |
| `src/looks.ts`                   | The three looks: markup, stylesheet, fonts, boot program, room colours, and where each zone stands in the room, in plain numbers shared with `tests/xr-check.mjs`.                                                                                              |
| `src/lookPicker.ts`              | The "Look" menu.                                                                                                                                                                                                                                                |
| `src/desk.ts`                    | Mounts a look and everything below that its markup asks for, and takes it all down again.                                                                                                                                                                       |
| `src/terminal.ts`                | The monitor's state: the listing, how much of it is typed, the prompt, the phosphor, and the commands. No DOM.                                                                                                                                                  |
| `src/programs.ts`                | What the disks hold.                                                                                                                                                                                                                                            |
| `src/screen.ts`                  | Draws the terminal on the screen, one way on the page and another in a session (below).                                                                                                                                                                         |
| `src/keyboard.ts`                | Builds the keycaps and types with them, and with a real keyboard. A character the monitor takes is not also acted on by a focused control, so the Look menu does not take it as type-ahead. A key a session's keyboard types into a field is the field's alone. |
| `src/phosphorMenu.ts`            | The menu under the screen.                                                                                                                                                                                                                                      |
| `src/dragAndDrop.ts`             | Disks into the drive, cards about the board, tickets between columns, new notes from the field.                                                                                                                                                                 |
| `src/charts.ts`                  | Keeps the charts panel moving: lines, bars, donuts, gauges and the log.                                                                                                                                                                                         |
| `src/clock.ts`                   | The wall clock's hands, and the digital clocks.                                                                                                                                                                                                                 |
| `src/tabs.ts`                    | The notebook's tabs, which mount one page at a time.                                                                                                                                                                                                            |
| `src/swatches.ts`                | The swatches that recolour the desk.                                                                                                                                                                                                                            |
| `src/power.ts`                   | The control that ends a session.                                                                                                                                                                                                                                |
| `src/stage.ts`                   | Scales the desk to the window, and takes the staging off during a session.                                                                                                                                                                                      |
| `src/session.ts`                 | Whether a session is showing the desk, from the session `@apendua.dev/headset` keeps and the scene writes.                                                                                                                                                      |
| `src/xr.ts`                      | The offer: the renderer, the Enter button, the SVG plugin and the note field's keyboard.                                                                                                                                                                        |
| `src/components/Scene.ts`        | The room in the look's colours, and each zone posed where the look places it.                                                                                                                                                                                   |
| `src/components/NoteKeyboard.ts` | What the note field's keyboard looks like in a session.                                                                                                                                                                                                         |
| `src/probe/`                     | The paint-order probe's scenes, its recorder and its page's script, above; `paint-order-probe.html` is its page and `vite/probeResults.js` the route that saves its results.                                                                                    |

Four things the page does differently while it is mirrored.

**The staging comes off.** On the page the desk is scaled to the window and the side panels and
everything lying on the desk are tilted with `perspective()` transforms, to look like a desk seen
from a chair. In a session the scene poses each object in the room, so `html[data-presenting]` turns
the scale and the tilts off and hides the feature notes, and every zone is measured flat and at its
own size. The page is under the session's canvas meanwhile. Two controls change with it. A key
pressed on the page moves down the screen, which in the room would be along the desk, so there the
caps stand proud of the board and a press pushes them into it; a disk lifted by the ray rises off
the desk the same way. And the control that ends the session becomes one, big enough to aim a ray
at.

**The monitor reveals its program instead of typing it.** On the page the listing is the typed part
of the program, rewritten every tick. In a session the text node holds the whole listing, and
`makeReveal` draws as much of it as has been typed: a tick is a uniform write, not a new run to
measure and rasterize. The terminal's state is the same for both, and the screen switches nodes when
a session starts or ends. While a program is typing in a session the screen scrolls to the last
character typed rather than to the bottom, since everything is in the node from the start.

**Only the objects are mirrored.** The page's wall, tabletop and backdrop are not, nor its
lamplight; the room has a wall, a desk and a floor of its own, in the look's colours. Beige Box
'84's mug is a mesh rather than a panel, because the page draws it from above and its steam rises
across the page, which lying on a desk in the room it could not do.

**Nothing runs until a session does.** The renderer is made with `presentingOnly`, and the room and
the panels are built when a session starts, from the look the page is showing, and taken down when
it ends.

Four things to know about it.

- Everything that moves moves on timers, not animation frames. A headset that has the display stops
  the page's animation frames, and timers keep going.
- An app's own scroll goes through freedom's `scrollElementBy`, which dispatches the `scroll` event
  the browser does not send while a session has the display. Without it the screen and the log would
  scroll on the page while their panels stayed put.
- The panels load slowly under the emulator in a browser without a GPU. Freedom gives the panels a
  share of each frame to mount in, and at a few frames a second the whole desk takes about a minute
  to come up. The charts come last, because their live updates keep arriving while they mount.
- Night Ops' telemetry panel used to stay on its loading frame under the emulator on a slow machine.
  A panel left its loading frame on a frame with nothing left to do, and the radar's sweep, its
  blips and the status lights blink without end, so at a few frames a second that frame did not
  come. Freedom no longer samples animations frame by frame while a panel loads, and only settles an
  animation that ends there, once. It lands a panel that something keeps busy after a second of
  waiting, one long frame at a time. A panel whose rows the timers add faster than a slow frame
  builds them, as the charts' were on the CI runner, lands once rows are still arriving five seconds
  into the wait. Neither has been tried on a headset.
