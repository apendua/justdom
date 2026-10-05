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
