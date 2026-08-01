# Knights

A turn based hex battle inspired by Heroes of Might and Magic III, and a port of
[KnightsJS](https://github.com/apendua/KnightsJS) — originally React, redux and
Meteor — onto `@apendua.dev/signal` for state and `@apendua.dev/dom` for
rendering. The sprite sheet and the backdrop are the original assets.

## Playing

Both armies are handed to the same player, so a game can be played on its own.
The stack whose turn it is stands on the red field, with everything it can reach
this turn shaded around it. Point somewhere inside that area to see the route it
would take, and click to send it there. Pointing at an enemy walks up to it and
attacks; the defender hits back, with whatever it has left. **Continue** hands
the turn over, or cuts short an animation that is still playing.

## How it is put together

The state lives in plain classes under `src/store`, with the parts that change
held in a `store()` and everything derived from them exposed as `@memo()`
getters. Nothing tells the view to update: components read those getters, and
the dom package re-runs only the bindings that touched a value that changed.

- `Game` owns one battle — the map, the stacks, and whose turn it is.
- `Actor` is a single stack of units. Every mutation refuses to touch a dead
  one, which is what keeps a stack that has just been wiped out from being
  knocked out again by an animation step queued before it died.
- `ActionQueue` plays a move out as a script — walk, land, swing, take the hit,
  swing back — one step at a time. It replaces the redux queue middleware of
  the original, and keeps its ability to cut the current step short without
  collapsing the rest.
- `BoardStore` turns the cursor position into a reachable area, a route and a
  preview of the move. Each step is memoized, so moving the cursor within one
  field doesn't re-run the flood fill behind it.

The geometry helpers under `src/helpers` — the hex neighborhood, the distance
map, the path finding and the outline tracing that draws a set of fields as a
single svg path — are ported from the original with their behavior intact, and
are covered by the tests next to them.

## Commands

```
rushx dev     # development server
rushx test    # unit tests
rushx build   # tests, typecheck and a production build
```
