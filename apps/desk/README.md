# Desk

A desk drawn in HTML and CSS, in three looks: a computer typing out its
program on its screen, a keyboard that types on it, a panel of live charts,
a board of cards, something to load programs from, and a paper to read. On
a page it is a page. In a headset `@apendua/freedom` mirrors each object into
a panel of its own and sets them out on a desk in a room.

It is the sampler for what freedom can mirror, written as one scene rather
than a grid of specimens. `apps/showcase-xr` stays as it is, because its
visual suite is a regression test for freedom and needs a scene that holds
still. The three looks are the mockups in
[`docs/showcase-desk`](../../docs/showcase-desk), each picked from the
"Look" menu in the corner:

| Look | `?look=` | The desk |
| --- | --- | --- |
| Beige Box '84 | `beige` | A beige computer in green phosphor, an instrument rack, a cork board, floppy disks, a memo on letterhead, a wall clock and a mug. |
| Night Ops | `ops` | A control room at night: amber phosphor, needle gauges and a radar, a whiteboard run as a kanban, cassettes, a green-bar printout and three world clocks. |
| Paper Studio | `paper` | A 1-bit desktop with the terminal in a window, a notebook with tabs, a linen pinboard whose swatches recolour the desk, cartridges, a letter with a wax seal and a plant. |

## Running it

```
npm run dev        # http://localhost:5173/apps/desk/
npm run build      # what `rush build` runs
```

The page needs the network for its fonts, which come from Google Fonts.
Each look loads its own.

The page opens on the look its address names, `?look=ops` for example, and
on Beige Box '84 without one. Picking another from the menu swaps it in
place and writes it into the address, so a reload or a link opens the same
desk. The menu is hidden while a session runs, which mirrors the look it
started with.

On a laptop there is no session to offer, so there is no button and no
renderer. `?emulator` installs a headset in the browser (IWER, with its dev
panels, from `@apendua.dev/headset`) and an Enter button appears at the
bottom; `?emulator=bare` installs the runtime without the panels.

`node tests/xr-check.mjs` puts each look up in turn in a session on the
emulated headset in headless Chromium. It fails unless every zone the look
places becomes a panel and loads, the ray aimed at the power control is on
it, and the trigger there ends the session, or if the page throws. It takes
about two minutes. `SHOTS=<dir>` also photographs each session, and
`STACKS=1` prints a stack for anything the page throws. It drives the
browser and the controller through `@apendua.dev/headset/driver`, which
borrows Playwright from `apps/showcase-xr` and launches the Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; `CHROMIUM=<path>`
points it at one installed elsewhere. A pull request that touches this app
or a package it imports runs it, with minesweeper's and Euclid's, from
`.github/workflows/driven.yml`.

## What you can do

- Type on your own keyboard, or click the keys. The monitor takes commands
  at its prompt; `HELP` lists them.
- Drag a floppy, cassette or cartridge onto the drive, deck or slot under
  the screen to load what is on it.
- Change the screen's colour from the phosphor control: the PHOSPHOR or
  AMBER button under the screen, or the desktop's Terminal menu.
- Beige Box '84: drag the cards about the board. The pink card's field pins
  a new note on Enter; while the field has focus the desk's keyboard types
  into it.
- Night Ops: drag tickets between the whiteboard's columns. A ticket lands
  above or below the others by where it is let go.
- Paper Studio: the notebook's tabs change its page, the swatches on the
  pinboard recolour the whole desk, and the scrap of paper on the pinboard
  takes notes as the pink card does.
- "Feature notes", top left, labels each object with what it exercises.

In a session the same things work with a controller's trigger or a pinch:
the keys are pressed with the ray, the floppies are dragged from their
panel onto the monitor's, and the board's field opens a keyboard of its own
in front of you, since the desk's keyboard is the monitor's. The charts,
the board and the memo can be picked up by their edges; the memo takes the
hand's whole rotation, so it can be tipped up to read. The power button
under the screen ends the session; on Night Ops it is PWR, and on Paper
Studio the terminal window's close box.

## How it is put together

Each look is its markup and its stylesheet in `src/looks/`, and an entry in
`src/looks.ts` that says how a session sets it out. `src/index.css` holds
what every look shares: the page's chrome and the rules for a session. Each
object is a `.zone` with an id, and the modules in `src/` make them move:

| File | What it is |
| --- | --- |
| `src/main.ts` | Puts up the look the address names, runs the menu that swaps it, and offers a session. |
| `src/looks.ts` | The three looks: markup, stylesheet, fonts, boot program, room colours, and where each zone stands in the room, in plain numbers shared with `tests/xr-check.mjs`. |
| `src/lookPicker.ts` | The "Look" menu. |
| `src/desk.ts` | Mounts a look and everything below that its markup asks for, and takes it all down again. |
| `src/terminal.ts` | The monitor's state: the listing, how much of it is typed, the prompt, the phosphor, and the commands. No DOM. |
| `src/programs.ts` | What the disks hold. |
| `src/screen.ts` | Draws the terminal on the screen, one way on the page and another in a session (below). |
| `src/keyboard.ts` | Builds the keycaps and types with them, and with a real keyboard. A character the monitor takes is not also acted on by a focused control, so the Look menu does not take it as type-ahead. |
| `src/phosphorMenu.ts` | The menu under the screen. |
| `src/dragAndDrop.ts` | Disks into the drive, cards about the board, tickets between columns, new notes from the field. |
| `src/charts.ts` | Keeps the charts panel moving: lines, bars, donuts, gauges and the log. |
| `src/clock.ts` | The wall clock's hands, and the digital clocks. |
| `src/tabs.ts` | The notebook's tabs, which mount one page at a time. |
| `src/swatches.ts` | The swatches that recolour the desk. |
| `src/power.ts` | The control that ends a session. |
| `src/stage.ts` | Scales the desk to the window, and takes the staging off during a session. |
| `src/session.ts` | Whether a session is showing the desk, from the session `@apendua.dev/headset` keeps and the scene writes. |
| `src/xr.ts` | The offer: the renderer, the Enter button, the SVG plugin and the note field's keyboard. |
| `src/components/Scene.ts` | The room in the look's colours, and each zone posed where the look places it. |
| `src/components/NoteKeyboard.ts` | What the note field's keyboard looks like in a session. |

Four things the page does differently while it is mirrored.

**The staging comes off.** On the page the desk is scaled to the window and
the side panels and everything lying on the desk are tilted with
`perspective()` transforms, to look like a desk seen from a chair. In a
session the scene poses each object in the room, so `html[data-presenting]`
turns the scale and the tilts off and hides the feature notes, and every
zone is measured flat and at its own size. The page is under the session's
canvas meanwhile. Two controls change with it. A key pressed on the page
moves down the screen, which in the room would be along the desk, so there
the caps stand proud of the board and a press pushes them into it; a disk
lifted by the ray rises off the desk the same way. And the control that
ends the session becomes one, big enough to aim a ray at.

**The monitor reveals its program instead of typing it.** On the page the
listing is the typed part of the program, rewritten every tick. In a
session the text node holds the whole listing, and `makeReveal` draws as
much of it as has been typed: a tick is a uniform write, not a new run to
measure and rasterize. The terminal's state is the same for both, and the
screen switches nodes when a session starts or ends. While a program is
typing in a session the screen scrolls to the last character typed rather
than to the bottom, since everything is in the node from the start.

**Only the objects are mirrored.** The page's wall, tabletop and backdrop
are not, nor its lamplight; the room has a wall, a desk and a floor of its
own, in the look's colours. Beige Box '84's mug is a mesh rather than a
panel, because the page draws it from above and its steam rises across the
page, which lying on a desk in the room it could not do.

**Nothing runs until a session does.** The renderer is made with
`presentingOnly`, and the room and the panels are built when a session
starts, from the look the page is showing, and taken down when it ends.

Four things to know about it.

- Everything that moves moves on timers, not animation frames. A headset
  that has the display stops the page's animation frames, and timers keep
  going.
- An app's own scroll goes through freedom's `scrollElementBy`, which
  dispatches the `scroll` event the browser does not send while a session
  has the display. Without it the screen and the log would scroll on the
  page while their panels stayed put.
- The panels load slowly under the emulator in a browser without a GPU.
  Freedom gives the panels a share of each frame to mount in, and at a few
  frames a second the whole desk takes about a minute to come up. The
  charts come last, because their live updates keep arriving while they
  mount.
- Night Ops' telemetry panel used to stay on its loading frame under the
  emulator on a slow machine. A panel left its loading frame on a frame
  with nothing left to do, and the radar's sweep, its blips and the status
  lights blink without end, so at a few frames a second that frame did not
  come. Freedom no longer samples animations frame by frame while a panel
  loads, and only settles an animation that ends there, once. It lands a
  panel that something keeps busy after a second of waiting, one long
  frame at a time. A panel whose rows the timers add faster than a slow
  frame builds them, as the charts' were on the CI runner, lands once
  rows are still arriving five seconds into the wait. Neither has been
  tried on a headset.
