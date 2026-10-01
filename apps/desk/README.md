# Desk

A 1984 desk drawn in HTML and CSS: a beige computer typing out its program
in green phosphor, a keyboard that types on it, an instrument panel of live
charts, a cork board of cards, floppy disks, a memo on letterhead, a clock
and a mug. On a page it is a page. In a headset `@apendua/freedom` mirrors
each object into a panel of its own and sets them out on a desk in a room.

It is the sampler for what freedom can mirror, written as one scene rather
than a grid of specimens. `apps/showcase-xr` stays as it is, because its
visual suite is a regression test for freedom and needs a scene that holds
still. The design is variant A of the mockups in
[`docs/showcase-desk`](../../docs/showcase-desk), unchanged.

## Running it

```
npm run dev        # http://localhost:5173/apps/desk/
npm run build      # what `rush build` runs
```

The page needs the network for its fonts, which come from Google Fonts.

On a laptop there is no session to offer, so there is no button and no
renderer. `?emulator` installs a headset in the browser (IWER, with its dev
panels) and an Enter button appears at the bottom; `?emulator=bare`
installs the runtime without the panels.

## What you can do

- Type on your own keyboard, or click the keys. The monitor takes commands
  at its prompt; `HELP` lists them.
- Drag a floppy onto the drive under the screen to load what is on it.
- Drag the cards about the board. The pink card's field pins a new note on
  Enter; while the field has focus the desk's keyboard types into it.
- Open the PHOSPHOR menu under the screen to change the screen's colour.
- "Feature notes", top left, labels each object with what it exercises.

In a session the same things work with a controller's trigger or a pinch:
the keys are pressed with the ray, the floppies are dragged from their
panel onto the monitor's, and the board's field opens a keyboard of its own
in front of you, since the desk's keyboard is the monitor's. The charts,
the board and the memo can be picked up by their edges; the memo takes the
hand's whole rotation, so it can be tipped up to read.

## How it is put together

The desk is the markup in `index.html` and the stylesheet in
`src/index.css`. Each object is a `.zone` with an id, and the modules in
`src/` make them move:

| File | What it is |
| --- | --- |
| `src/main.ts` | Finds the elements and mounts everything below onto them, then offers a session. |
| `src/terminal.ts` | The monitor's state: the listing, how much of it is typed, the prompt, the phosphor, and the commands. No DOM. |
| `src/programs.ts` | What the disks hold. |
| `src/screen.ts` | Draws the terminal on the screen, one way on the page and another in a session (below). |
| `src/keyboard.ts` | Builds the keycaps and types with them, and with a real keyboard. |
| `src/phosphorMenu.ts` | The menu under the screen. |
| `src/dragAndDrop.ts` | Floppies into the drive, cards about the board, new notes from the field. |
| `src/charts.ts` | Keeps the charts panel moving. |
| `src/clock.ts` | The wall clock's hands. |
| `src/stage.ts` | Scales the desk to the window, and takes the staging off during a session. |
| `src/session.ts` | Whether a session is showing the desk, written by the scene. |
| `src/xr.ts` | The offer: the renderer, the Enter button, the SVG plugin and the note field's keyboard. |
| `src/components/Scene.ts` | The room, and where each object stands in it. |
| `src/components/NoteKeyboard.ts` | What the note field's keyboard looks like in a session. |

Four things the page does differently while it is mirrored.

**The staging comes off.** On the page the desk is scaled to the window and
the side panels, the keyboard, the floppies and the memo are tilted with
`perspective()` transforms, to look like a desk seen from a chair. In a
session the scene poses each object in the room, so `html[data-presenting]`
turns the scale and the tilts off and hides the feature notes, and every
zone is measured flat and at its own size. The page is under the session's
canvas meanwhile.

**The monitor reveals its program instead of typing it.** On the page the
listing is the typed part of the program, rewritten every tick. In a
session the text node holds the whole listing, and `makeReveal` draws as
much of it as has been typed: a tick is a uniform write, not a new run to
measure and rasterize. The terminal's state is the same for both, and the
screen switches nodes when a session starts or ends. While a program is
typing in a session the screen scrolls to the last character typed rather
than to the bottom, since everything is in the node from the start.

**Only the objects are mirrored.** The page's wall, tabletop and backdrop
are not; the room has a wall, a desk and a floor of its own, in the page's
colours. The mug is a mesh rather than a panel, because the page draws it
from above and its steam rises across the page, which lying on a desk in
the room it could not do.

**Nothing runs until a session does.** The renderer is made with
`presentingOnly`, and the panels are built when a session starts and taken
down when it ends.

Three things to know about it.

- Everything that moves moves on timers, not animation frames. A headset
  that has the display stops the page's animation frames, and timers keep
  going.
- An app's own scroll goes through freedom's `scrollElementBy`, which
  dispatches the `scroll` event the browser does not send while a session
  has the display. Without it the screen and the log would scroll on the
  page while their panels stayed put.
- Under the emulator in a browser without a GPU the charts panel can stay
  on its loading frame. A panel stops loading on a frame where nothing is
  left to do, and at a few frames a second the charts change faster than
  freedom's five milliseconds a frame can keep up with. With
  `portalBudget` raised to 60 ms a frame, which is nearer what a headset
  spends in a second, the same session has every panel up in five seconds.
