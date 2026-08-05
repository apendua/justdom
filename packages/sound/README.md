# @apendua.dev/sound

The noises the demos make. Internal to this repo, and not published.

`@apendua.dev/media` is the other half of the same subject and holds the files —
the soundtracks the apps stream. This one holds the sounds that are cheaper to
compute than to fetch, and the three.js plumbing that puts them somewhere in the
room rather than in the middle of your head.

```
rush build --to @apendua.dev/sound
```

## What is in it

**`createClickWaveform(sampleRate)`** — fifty milliseconds of knock with a
little ring left in it, the way two magnets sound when they meet: a scrape of
contact noise on the leading edge, two partials ringing under it, faded at both
ends so it cannot pop. It returns a `Float32Array` ready for
`AudioBuffer.copyToChannel` and touches no Web Audio API at all, which is why it
is tested in Node. The noise comes from a seeded generator, so the click is the
same sound in every session and can be asserted on.

**`createClicks(listener, options?)`** — the same click, in the room. It hands
back an object to add to the scene and a `play(position)` that sounds a click at
a point in *that object's* coordinates:

```ts
const clicks = createClicks(listener);
// Inside the board, so a click sounds from the cell it belongs to.
board.add(clicks.object);
// ...on landing a brick:
clicks.play(cellCentre);
```

Add it to the board rather than to the scene: a board is usually scaled and
parked at arm's length, and the positions the game already has are in its
coordinates, not the room's.

`options` covers the three things an app is likely to disagree about —
`voices`, `refDistance`, `volume` — and the defaults suit a board about a metre
square within arm's reach, which is every app here so far.

## Two things worth knowing

**Several voices.** One `PositionalAudio` node cannot play two clicks at once,
and placing bricks quickly is the whole game. Four voices are used in turn, so a
click only ever cuts off one that is already several placements old.

**The panner is placed after `play()`.** three.js only moves a positional
sound's panner while the sound is playing, and reads it as the note starts.
Setting the position and waiting for the next frame would put the click wherever
the *last* one landed.

## Used by

`castle-xr` and `marblerun`, each on a brick coming to rest. Not `bricks-xr`:
that one is a worked example, kept to the smallest thing that still builds
something, and a sound is not part of what it is there to show.
