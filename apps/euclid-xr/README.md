# Euclid XR

The euclid construction editor moved into the room: a drawing board hangs an
arm's length away like a drafting table, and constructions are made with the
controllers. Built on `@apendua/freedom` over the same
`@apendua.dev/euclid-lang` as the 2D editor — the code is still the single
source of truth, and every construction step made by hand writes a statement.

The program itself hangs beside the board through freedom's DOM portal, with
the same token colors as the 2D editor — read-only here, since in XR the code
writes itself. The right panel holds the tools, view controls, the bundled
classical constructions and the soundtrack.

The soundtrack is `paper_and_running_water.mp3` out of `@apendua.dev/media`,
played by `@apendua.dev/sound/xr`: looping for as long as the session lasts and
stopping with it, so the browser tab stays silent until the headset goes on. It
starts at 40% — under the drawing rather than over it — and the music card
steps it in tenths. On a
desktop with more than one output plugged in, a picker appears under the
volume to say which one the sound goes to; a headset with a single output has
nothing to choose between, so nothing is shown.

## Controls

- **Trigger** — the active tool: place a point (snapping to points and
  crossings), pick the two points of a line or a circle, name an
  intersection, or select and drag a free point.
- **Grip** — pan the sheet under the ray.
- Panels are ordinary ray-and-trigger buttons.

Each hand's ray carries freedom's cursor at its end — the same small mark
wherever it lands, on the paper as on the panels. On the paper it is joined by
the marks that only mean something there: the rubber band of the tool in
progress, and the ring around the point a click would snap to.

## Development

```
rushx dev       # start the dev server (https)
rushx test      # run the studio store tests
rushx build     # typecheck, test and build
```

The deployed build accepts `?emulator`, which installs an emulated Quest 3
([iwer](https://github.com/meta-quest/immersive-web-emulation-runtime)) so
the board can be tried in an ordinary browser; `?emulator=bare` skips the
dev UI so scripts can drive the headset themselves. The app exposes
`window.__studio` for such scripts. Two things matter when driving iwer
headless: poses live in its global space (the floor at y=0, the headset
starting at (0, 1.6, 0) — the origin of the `local` reference space), and
button presses must straddle XR animation frames, so hold the trigger for a
few `session.requestAnimationFrame` ticks before releasing.
