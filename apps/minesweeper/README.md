# Hex Minesweeper

Minesweeper on a hexagonal grid, with no framework under it. On a page the
board is one `<svg>` wired to signals and the menu is a card floating over
its corner. On a headset it is the very same DOM: the page keeps it, and
`@apendua/freedom` mirrors the board and the menu into two panels in front
of the viewer, the way `todo-vanilla` mirrors its list.

## Running it

```
npm run dev        # http://localhost:5173
npm run build      # what `rush build` runs
```

On a laptop the page is the page and nothing else: no session can be opened,
so no button is shown, no renderer is made and three.js is never fetched.
`?emulator` installs a headset in the browser (IWER, with its dev panels) and
the **Enter** button appears at the bottom; press it and the emulated session
is drawn over the page. `?emulator=bare` installs the runtime without the
panels.

`node tests/xr-check.mjs` first loads the page alone in headless Chromium,
which can present nothing, and fails if the headset scene is fetched. Then
it plays a session on the emulated headset, which takes about a minute: it
flags a tile with the grip, uncovers tiles with the trigger, deals a new board and restarts it
from the menu panel, turns the passthrough on and leaves by the ×, and fails
if any of that does not happen or the page throws. `SHOTS=<dir>` also
photographs the page and the session, and `STACKS=1` prints a stack for
anything the page throws. It borrows Playwright from `apps/showcase-xr`, so
that project has to have been installed.

## How it is put together

| File | What it is |
| --- | --- |
| `src/main.ts` | Mounts the board into `#board` and the menu into `#menu`, then offers a session that mirrors both. |
| `src/components/Game.ts` | The state, and the two trees over it: the board, rebuilt for each new game, and the menu, built once. |
| `src/components/Minefield.ts` | The board: one `<svg>`, its covered tiles one traced path, finding the tile under a press from where it was pressed. |
| `src/components/Menu.ts` | The card: the size, the mines left, how the game stands, Restart, and the × and Passthrough a session adds. |
| `src/offer.ts` | The offer: installs the emulator behind `?emulator`, checks the platform can present, and only then loads `xr.ts`. Imports nothing from three.js. |
| `src/xr.ts` | The session: makes the renderer with freedom's SVG plugin, and the Enter button. |
| `src/components/Scene.ts` | The scene: the two panels, a backdrop, lights, the cursors and the frame rate. |
| `src/placement.ts` | Where the panels hang, in plain numbers, shared with `tests/xr-check.mjs`. |
| `src/session.ts` | The session the page is shown in and the passthrough switch, written by the scene and read by the menu. |
| `src/emulator.ts` | IWER, behind `?emulator`. |

The board and the menu are mounted in two places because a panel is the
element it mirrors, and the two hang apart in a session. The board's element
fills the window, as it always has, so its panel is mostly empty: it is
made transparent to rays, and only the covered tiles, the one shape with
`cursor: pointer`, stop one. It is scaled as the session starts so that the
board stands 60 cm tall whatever window the page was laid out in. The menu
hangs to its left, turned to face the viewer, and can be moved by its edges.

The board needs nothing from the headset. A trigger press on a tile is a
`click` on the `<svg>` and the grip is a `contextmenu`, each carrying the
point the ray met as `clientX` and `clientY`, so the handlers that already
serve the mouse find the tile.

Two controls are there only in a session: the × in the card's corner, which
ends it, and Passthrough, which takes down the dark sphere the session is
set against and shows the room. They are mounted when a session starts
rather than hidden and shown, since a panel measures the card again when its
children change and not when one of them is hidden.
