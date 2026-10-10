# Knights

A turn based hex battle inspired by Heroes of Might and Magic III, and a port of
[KnightsJS](https://github.com/apendua/KnightsJS) — originally React, redux and Meteor — onto
`@apendua/signal` for state and `@apendua/justdom` for rendering. The sprite sheet and the backdrop
are the original assets.

## Playing

You command the white army; the menu behind ☰ picks whether the black one is played by the computer
or by you as well (hotseat). The stack whose turn it is stands on the red field, with everything it
can reach this turn shaded around it. Point somewhere inside that area to see the route it would
take, and click to send it there. Pointing at an enemy walks up to it and attacks; the defender hits
back, with whatever it has left.

**Continue** hands the turn over without moving. While a move is playing out the same button reads
**Skip** and cuts the animation short — including the computer's.

## In a headset

On a headset the game is the very same DOM. The page keeps it, and `@apendua/freedom` mirrors the
whole of `#root`, the battlefield and the toolbar under it, into one panel in front of the viewer,
the way `minesweeper` and `euclid` mirror theirs. The ray moving over the board is a `mousemove` and
the trigger is a `click`, each carrying the place on the page the ray met, so the handlers that
serve the mouse preview the route and send the stack along it. The menu behind ☰ opens over the
battlefield in the panel as it does on the page.

Two controls are there only in a session: Passthrough, which takes down the dark sphere the session
is set against and shows the room, and the × at the end of the toolbar, which ends the session.

On a laptop the page is the page and nothing else. No session can be opened, so no button is shown,
no renderer is made and three.js is never fetched. `?emulator` installs a headset in the browser
(IWER, with its dev panels) and the **Enter** button appears at the bottom. Press it and the
emulated session is drawn over the page. `?emulator=bare` installs the runtime without the panels.

The page needed four changes to look the same in the panel, each one invisible on the page:

- The battlefield behind the board is an `<img>` under the rest, not the container's
  `background-image`. A panel draws a `url()` background as nothing, which left the black grid on a
  black room.
- A sprite's frame is picked by the image's `transform`, not its `x` and `y`. A panel takes a new
  `transform` as a matrix write, where a new `x` and `y` would be a new quad ten times a second for
  every stack. The frame's `clip-path` is on a group around the image, so the `transform` does not
  move the clip with it.
- The walls are filled `url(#…) black`. A panel draws no `<pattern>` yet, and draws the fallback
  colour instead, so the walls are solid black there and hatched on the page.
- The board carries `cursor: pointer` while it takes orders. A panel sends the ray's moves and
  presses only to what is under `cursor: pointer`.

`node tests/xr-check.mjs` loads the page alone in headless Chromium, which can present nothing, and
fails if the headset scene is fetched. Then it plays on the emulated headset, which takes about a
minute: it points the ray at a field the white stack can reach and checks that the route is drawn,
pulls the trigger and checks that the click reached the board at that place and the turn passed on,
then turns the passthrough on and leaves by the ×. `SHOTS=<dir>` also photographs the page and the
session, and `STACKS=1` prints a stack for anything the page throws. It drives the browser and the
controller through `@apendua.dev/headset/driver`, which borrows Playwright from `apps/showcase-xr`,
so that project has to have been installed. It launches the Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; `CHROMIUM=<path>` points it at one installed
elsewhere. A pull request that touches this app or a package it imports runs it, with minesweeper's,
the desk's and Euclid's, from `.github/workflows/driven.yml`.

| File                      | What it is                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/offer.ts`            | Installs `@apendua.dev/headset`'s emulator behind `?emulator`, checks the platform can present, and only then loads `xr.ts`. Imports nothing from three.js. |
| `src/xr.ts`               | Makes the renderer with freedom's SVG plugin, and the Enter button.                                                                                         |
| `src/components/Scene.ts` | The panel, a backdrop, lights and the cursors.                                                                                                              |
| `src/placement.ts`        | Where the panel hangs, in plain numbers, shared with `tests/xr-check.mjs`.                                                                                  |

## How it is put together

The state lives in plain classes under `src/store`, with the parts that change held in a `store()`
and everything derived from them exposed as `@memo()` getters. Nothing tells the view to update:
components read those getters, and the dom package re-runs only the bindings that touched a value
that changed.

- `Game` owns one battle — the map, the stacks, whose turn it is, and which of the two armies takes
  its orders from the screen rather than from the computer.
- `Actor` is a single stack of units. Every mutation refuses to touch a dead one, which is what
  keeps a stack that has just been wiped out from being knocked out again by an animation step
  queued before it died.
- `ActionQueue` plays a move out as a script — walk, land, swing, take the hit, swing back — one
  step at a time. It replaces the redux queue middleware of the original, and keeps its ability to
  cut the current step short without collapsing the rest.
- `BoardStore` turns the cursor position into a reachable area, a route and a preview of the move.
  Each step is memoized, so moving the cursor within one field doesn't re-run the flood fill behind
  it.

The geometry helpers under `src/helpers` — the hex neighborhood, the distance map, the path finding
and the outline tracing that draws a set of fields as a single svg path — are ported from the
original with their behavior intact, and are covered by the tests next to them.

Nothing is stored on the player's machine. The original carried a user id in a cookie because it was
built to be played over a network; the port is local, so there is nothing to remember between
visits.

### The computer player

`chooseMove` in `src/store/bot.ts` decides what one stack does with its turn. It is deliberately
shallow — one turn deep, with no model of what the opponent will do next:

1. Of every enemy it can reach and hit this turn, take the best trade. A trade is scored as the
   damage dealt, weighted, less what the survivors deal back, with a large bonus for wiping a stack
   out — a stack that is gone never swings again, and a mauled one hits for less.
2. Failing that, walk as far as it can toward the enemy whose doorstep is the fewest steps away.
3. Failing that too, stand still and pass.

`BotPlayer` is what makes it play: it watches `isWaitingForBot`, which the game derives from its own
state, so the computer's turn comes round on its own once a move has finished playing out. That is
enough to beat a player who does nothing, which is the bar it was written to clear.

## Commands

```
rushx dev     # development server
rushx test    # unit tests
rushx build   # tests, typecheck and a production build
```
