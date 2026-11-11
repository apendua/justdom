# Knights

A turn based hex battle inspired by Heroes of Might and Magic III, and a port of
[KnightsJS](https://github.com/apendua/KnightsJS) — originally React, redux and Meteor — onto
`justdom-signal` for state and `justdom-core` for rendering. The sprite sheet and the backdrop are
the original assets.

## Playing

You command the white army; the menu behind ☰ picks whether the black one is played by the computer
or by you as well (hotseat). The stack whose turn it is stands on the red field, with everything it
can reach this turn shaded around it. Point somewhere inside that area to see the route it would
take, and click to send it there. Pointing at an enemy walks up to it and attacks; the defender hits
back, with whatever it has left.

**Continue** hands the turn over without moving. While a move is playing out the same button reads
**Skip** and cuts the animation short — including the computer's.

On a page narrower than 600 px, the breakpoint Minesweeper uses too, a phone held upright, the
toolbar keeps only ☰, **Continue** and the round. The way of playing moves into the menu behind ☰,
and in a headset session so do Passthrough and the way out, which the menu calls **Leave the
headset**. `src/viewport.ts` holds the breakpoint as a signal, so the items are mounted and taken
down as the page crosses it rather than hidden: a panel measures the toolbar again when its children
change, and not when one of them is hidden. The toolbar's buttons scale with the page's height, but
no further than lets them fit across a tablet held upright, and never get shorter than 32 px, so
they stay a fingertip tall on a phone held sideways.

## In a headset

On a headset the game is the very same DOM. The page keeps it, and `justdom-three` mirrors the whole
of `#root`, the battlefield and the toolbar under it, into one panel in front of the viewer, the way
`minesweeper` and `euclid` mirror theirs. The ray moving over the board is a `mousemove` and the
trigger is a `click`, each carrying the place on the page the ray met, so the handlers that serve
the mouse preview the route and send the stack along it. The menu behind ☰ opens over the
battlefield in the panel as it does on the page.

Two controls are there only in a session: Passthrough, which takes down the dark sphere the session
is set against and shows the room, and the × at the end of the toolbar, which ends the session. On a
narrow page both are in the menu behind ☰ instead.

The battle theme is the page's until a session starts. The page plays it from an `<audio>` element,
from the first click or key press on. Once a session has started, the scene plays it through
`@apendua/sound/xr`'s `Music`, as Castle does, from the moment each session starts to the moment it
ends, and the page's `<audio>` is taken down for good. A player who leaves the headset comes back to
a quiet page. `src/headset.ts` holds whether a session has started, which `xr.ts` sets.

On a laptop the page is the page and nothing else. No session can be opened, so no button is shown,
no renderer is made and three.js is never fetched. `?emulator` installs a headset in the browser
(IWER, with its dev panels) and the **Enter** button appears at the top, over the sky in the
backdrop, since justdom-three's place for it at the bottom is the toolbar's. Press it and the
emulated session is drawn over the page. The controller and hand models come from three's default
CDN, so a headset with no network draws no models. `?emulator=bare` installs the runtime without the
panels. On a phone `?emulator` installs `justdom-xr`'s touch layer instead of the panels
(`?emulator=devui` keeps them), and `?touch` installs it anywhere: once the session is up, a drag
turns the head, a tap presses what it lands on, a finger held still for 400 ms and then moved drags
it, held and lifted is a long press, and two fingers pinch the view in and out.

The page needed four changes to look the same in the panel. The first three do not show on the page;
the fourth does:

- The battlefield behind the board is an `<img>` under the rest, not the container's
  `background-image`. A panel draws a `url()` background as nothing, which left the black grid on a
  black room.
- A sprite's frame is picked by the image's `transform`, and the frame's `clip-path` is on a group
  around the image, so the `transform` does not move the clip with it. A panel cuts the picture's
  quad down to what the clip leaves, so it draws one frame of the sheet and not all 152, and a new
  frame rewrites that quad's corners in place.
- The walls are filled `url(#…) black`. A panel draws no `<pattern>` yet, and draws the fallback
  colour instead, so the walls are solid black there and hatched on the page.
- The board carries `cursor: pointer` while it takes orders, so on the page the mouse is a hand over
  the whole board, walls and fields out of reach included. A panel sends the ray's moves and presses
  only to what is under `cursor: pointer`.

A click sends the stack to the field it lands on, not along the route the last `mousemove` showed.
In a headset only the primary hand moves the mouse while either hand's trigger clicks, so the last
move can be the other hand's, and a tap on a touchscreen comes with no move at all.

`node tests/xr-check.mjs` loads the page alone in headless Chromium, which can present nothing, and
fails if the headset scene is fetched, if the menu behind ☰ does not stack its items one under
another, or if a click on a field the white stack can reach, with no move before it, does not send
the stack there. It loads the page again at a phone's size and fails if the toolbar is not three
items on one line inside the screen, with the way of playing in the menu, or if turning the page
sideways does not put that back in the toolbar. Then it loads the page with the emulator and fails
if the Enter button covers the toolbar. Then it plays on the emulated headset, which takes about a
minute: it checks that the theme the page played before the session now plays from the scene and not
from the page, points the ray at a field the white stack can reach and checks that the route is
drawn, pulls the trigger and checks that the click reached the board at that place and the turn
passed on, then turns the passthrough on, leaves by the × and checks that the theme stopped. The
page alone must play the theme itself after a click. `SHOTS=<dir>` also photographs the page and the
session, and `STACKS=1` prints a stack for anything the page throws. It drives the browser and the
controller through `justdom-xr/driver`, which launches the Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; `CHROMIUM=<path>` points it at one installed
elsewhere. A pull request that changes this app or a package it imports, other than in docs, unit
tests or benchmarks, runs it, with minesweeper's, the desk's and Euclid's, from
`.github/workflows/driven.yml`.

| File                      | What it is                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`             | Mounts the game into `#root`, then offers a session through `offerHeadset` from `justdom-xr/offer`, which loads `xr.ts` only where one can open.                                            |
| `src/xr.ts`               | Makes the renderer with `justdom-three`'s SVG plugin and the controller and hand models from `justdom-xr`'s `inputModels()`, follows `?theming` and `?outlines`, and adds the Enter button. |
| `src/components/Scene.ts` | The panel, `justdom-xr/scene`'s backdrop, lights, the cursors and the session's music.                                                                                                      |
| `src/placement.ts`        | Where the panel hangs, in plain numbers, shared with `tests/xr-check.mjs`.                                                                                                                  |

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
