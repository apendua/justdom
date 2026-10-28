# Hex Minesweeper

Minesweeper on a hexagonal grid, with no framework under it. On a page the board is one `<svg>`
wired to signals and the menu is a card beside it, or above it in a tall window. On a headset it is
the very same DOM: the page keeps it, and `@apendua/freedom` mirrors the board and the menu into two
panels in front of the viewer, the way `todo-vanilla` mirrors its list.

## Running it

```
npm run dev        # http://localhost:5173
npm run build      # what `rush build` runs
```

On a laptop the page is the page and nothing else: no session can be opened, so no button is shown,
no renderer is made and three.js is never fetched, not even by the service worker, which leaves the
headset's chunks out of its precache. It leaves the controller and hand models under `profiles/` out
too, so a session needs the network. `?emulator` installs a headset in the browser (IWER, with its
dev panels) and the **Enter** button appears at the bottom; press it and the emulated session is
drawn over the page. `?emulator=bare` installs the runtime without the panels.

`node tests/xr-check.mjs` first builds the app for production and fails unless its service worker
precaches exactly the JS the page loads: the entry chunk and what it imports, and none of the chunks
only a headset or the emulator imports, since the worker is installed on every visit. It then loads
the page alone in headless Chromium, which can present nothing, and fails if the headset scene is
fetched, or if any covered tile or any of the card is under something else in a wide window, a tall
one or a phone's. Then it plays a session on the emulated headset, which takes about a minute: it
flags a tile with the grip, uncovers tiles with the trigger, deals a new board and restarts it from
the menu panel, turns the passthrough on and leaves by the ×, and fails if any of that does not
happen or the page throws. `SHOTS=<dir>` also photographs the page and the session, and `STACKS=1`
prints a stack for anything the page throws. `PAINT_ORDER=1` runs it on panels drawn in paint order
(`?paintOrder`), for `docs/freedom-paint-order-plan.md`. It drives the browser and the controller
through `@apendua.dev/headset/driver`, which borrows Playwright from `apps/showcase-xr`, so that
project has to have been installed. It launches the Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; `CHROMIUM=<path>` points it at one installed
elsewhere. A pull request that changes this app or a package it imports, other than in docs, unit
tests or benchmarks, runs it, with the desk's, Euclid's and Knights', from
`.github/workflows/driven.yml`.

## How it is put together

| File                          | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                 | Mounts the board into `#board` and the menu into `#menu`, then offers a session that mirrors both, through `@apendua.dev/headset`'s `offerHeadset`, which loads `xr.ts` only on a platform that can present.                                                                                                                                                                                                                              |
| `src/components/Game.ts`      | The state, and the two trees over it: the board, rebuilt for each new game, and the menu, built once.                                                                                                                                                                                                                                                                                                                                     |
| `src/components/Minefield.ts` | The board: one `<svg>`, its covered tiles one traced path, finding the tile under a press from where it was pressed.                                                                                                                                                                                                                                                                                                                      |
| `src/components/Menu.ts`      | The card: the size, the mines left, how the game stands, Restart, and the × and Passthrough a session adds.                                                                                                                                                                                                                                                                                                                               |
| `src/xr.ts`                   | The session: makes the renderer with freedom's SVG plugin and the controller and hand models from this app's origin, and the Enter button.                                                                                                                                                                                                                                                                                                |
| `src/components/Scene.ts`     | The scene: the two panels, a backdrop, lights, the cursors and the frame rate.                                                                                                                                                                                                                                                                                                                                                            |
| `src/placement.ts`            | Where the panels hang, in plain numbers, shared with `tests/xr-check.mjs`.                                                                                                                                                                                                                                                                                                                                                                |
| `@apendua.dev/headset`        | Not a file here, but shared with the other headset apps: IWER behind `?emulator` and the offer of a session, which reloads once a newer service worker has the page if a deploy took either chunk away; `canPresent`; the session the page is shown in and the passthrough switch, written by the scene and read by the menu; the backdrop; and the controller and hand models, which `vite.config.mts` serves from `@apendua.dev/media`. |

The board and the menu are mounted in two places because a panel is the element it mirrors, and the
two hang apart in a session. On the page the menu sits beside the board, or above it in a window
taller than it is wide, and the board's element takes the rest of the window. The board is fitted to
that element, not to the window, so no tile is ever under the card. Its panel is the element's whole
box, mostly empty around the hexes: it is made transparent to rays, and only the covered tiles, the
one shape with `cursor: pointer`, stop one. It is scaled from its element's size so that the board
stands 60 cm tall whatever size the element was laid out at, as the session starts and again
whenever the element is resized, as it is when the window is. The menu hangs to its left, turned to
face the viewer, and can be moved by its edges.

The board needs nothing from the headset. A trigger press on a tile is a `click` on the `<svg>` and
the grip is a `contextmenu`, each carrying the point the ray met as `clientX` and `clientY`, so the
handlers that already serve the mouse find the tile.

Two controls are there only in a session: the × in the card's corner, which ends it, and
Passthrough, which takes down the dark sphere the session is set against and shows the room. They
are mounted when a session starts and taken down when it ends.
