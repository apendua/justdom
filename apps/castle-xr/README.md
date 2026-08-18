# Castle XR

Build a castle out of bricks in passthrough AR, then take a slingshot to it and
knock the whole thing down. The game is won when every brick is lying on the
ground.

It is built on the same stack as [marblerun](../marblerun/README.md), and the
building half is deliberately the same to use: `@apendua/signal` for
reactivity, `@apendua/freedom` for the reactive scene, `@apendua/justdom`
projected into it for the panels, and `@dimforge/rapier3d` for the physics.

```
rush build --to @apendua.dev/castle-xr
cd apps/castle-xr && npm run dev
```

Open the printed `https://` URL in a headset browser and press **Start AR**
(passthrough). On a headset without passthrough the button falls back to
plain VR instead of refusing to work.

- `?emulator` — installs the [iwer](https://github.com/meta-quest/immersive-web-emulation-runtime)
  Quest 3 emulator with its DevUI, which fakes a headset and two controllers in
  an ordinary browser.
- `?emulator=bare` — the same without the DevUI, and with the `XRDevice` exposed
  as `window.xrDevice` so a script can drive the headset and controllers
  directly. The DevUI writes a pose of its own every frame and would otherwise
  fight whatever the script is doing.

The emulator is a dynamic import in its own chunk and replaces `navigator.xr`,
so do not use it on a real headset.

The castle is saved to `localStorage` (key `castle-xr:castle`) a moment after
the last change. The soundtrack is the house one, `glass_desk_habits.mp3` out of
`@apendua.dev/media`, started with the session and stopped with it — played by
`@apendua.dev/sound/xr`, which every headset app here shares.

A brick that lands clicks, from the cell it landed in — a knock with a little
ring in it, the way two magnets sound when they meet. Both halves of that come
from `@apendua.dev/sound`: the waveform is generated rather than loaded, and
`createClicks` parks a handful of `PositionalAudio` voices in the board to play
it, so the click arrives from where the brick is rather than from the middle of
your head. It is the one piece of feedback that does not need looking at, which
is what a brick placed behind the one in your hand needs.

## The board

The board floats a little below eye level and about an arm's length away. It is
scaled by `0.1`, so one cell is ten centimetres in the room and the whole board
is a 60 cm square — a castle you build at a table rather than one you walk
through. The session runs in a `local` reference space, so the origin is
wherever the player's head was when they pressed Start.

That is only where it starts. **The board is carried by its floor**: a trigger
pull on any bare part of the plate picks the whole scene up — board, tray,
panels and lighting together — and carries it with the hand, so it can be put
down on the real table in front of you, or off to one side, or wherever the room
actually has space. Letting go leaves it there.

**It stays level while it is carried** (`utils/carry.ts`). A hand reaching out
across a board rolls and pitches far more than it feels like it does, and a
board handed the wrist's whole pose arrives on its side with the castle sliding
off it. So the wrist never tilts the board — but everything else it does is
followed, and the reference for all of it is the **grab point**: the spot the
ray landed on when the trigger closed. That spot stays pinned to the ray, as
far out along it as it was taken hold of, so tipping the wrist tows the board
where the ray now points instead of leaving the cursor to slide across it; and
the turn about the vertical pivots the board *about the grab point*, so the
spot being held is the one spot that never moves.

**A carry can change hands without being put down.** A press from the other
hand while the board is being carried takes the grip over from wherever its own
ray lands; the first hand's release then changes nothing. The same handover
works for a brick being dragged.

The presses are taken by the floor rather than by the scene as a whole, so that
only the floor can start a carry. A press that bubbled up from anywhere else — a
panel that did not want it, whatever sits behind one — would otherwise carry the
board off, which is a surprising thing for a board to do when the player has just
pressed a button. Carrying is also building-only: during the siege the triggers
belong to the slingshot.

Every colour in the game comes from `elements/palette.ts`, panels included, so
the interface and the world it sits in cannot drift apart. The board is deep
teal and the bricks are the one warm thing standing on it; the panels take the
bricks' side of that split — parchment in a bronze frame, Cinzel capitals for
titles, Quicksand for everything else, pill-shaped oak-and-gilt buttons — so
the interface belongs with the castle rather than with the table. Cyan is kept
for what the player is *about* to do — the ghost of a brick, the pointer — so
it never competes with anything already built.

## Bricks and the half grid

| Brick  | Size (cells)    |
| ------ | --------------- |
| Cube   | `1 x 1 x 1`     |
| Block  | `2 x 1 x 0.5`   |
| Plate  | `2 x 0.5 x 1`   |
| Pillar | `0.5 x 2 x 0.5` |
| Roof   | `1 x 1 x 1`     |

Every side is a whole multiple of half a cell, and that is what makes the grid
work. What has to line up when two bricks meet is their **faces**, not their
centres, so the grid is applied to the corner: the low corner of a brick's box
lands on a multiple of `0.5` and the centre follows from the brick's own size
and orientation (`utils/grid.ts`). A plate lands flush on a cube, a pillar
stands flush beside a block, and a brick aimed at the floor rests on it instead
of sinking half way through. Orientation is one of the 24 rotations of a cube,
so a turned brick's extent is a permutation of its own sides and stays on the
grid.

The roof is the one brick that is not a box: it fills its cell up to a ridge
running along x. It is still treated as its box everywhere placement is decided,
and its collider is the convex hull of the same six sharp corners.

**Every brick is drawn with a small chamfer** (`bevelledBoxGeometry`,
`bevelledWedgeGeometry`): each face is pulled in within its own plane and the
convex hull of what is left grows the bevel faces along every edge by itself.
The bevels catch the light along the seams, which is what lets one brick be
told from the next when they sit flush. It is drawing only — the colliders
keep the sharp corners, so bricks still stack with no slivers of gap in the
simulation, and the overlap test still reasons about exact boxes.

**A brick may not be dropped inside another one.** Bricks are boxes on axis
aligned rotations, so the overlap test is exact, and the preview turns red where
a brick would not fit. This is not fussiness: overlapping bodies handed to
Rapier shove each other apart, and a castle that explodes the moment the siege
starts is nobody's idea of a castle.

## Building

Straight out of marblerun, minus the port snapping, which a stacked castle has
no use for:

- The tray shows the whole catalogue at once, each brick in the orientation it
  will land in, at half size so the row stays within reach. **Picking a brick
  up brings it to full size** — what is in the hand is the brick, not the
  miniature. Pulling one off hands over a copy and leaves the tray as it was.
  The tray moves by its **side rails** only, so a ray that misses a brick never
  carries the whole thing off.
- **The preview is the brick** — the real brick in a ghost material, at the pose
  it will land in, drawn inside the board's own coordinate space.
- **The wrist picks the brick's orientation freely**, snapped to the nearest of
  the cube's 24 rotations (`align`): turning a brick over in the hand is enough
  to lay it on its side or its face. The **thumbstick** still composes 90°
  steps on top of what the hand is holding, for the turns a wrist cannot
  comfortably reach.
- **Grip pulls out a copy** of a brick already placed.
- **Dragging a brick off the board deletes it.**
- Placing, moving and removing are recorded as what the brick looked like before
  and after, so both directions can be walked (`store/History.ts`). The two near
  face buttons undo and redo, as do the buttons on the panel.

## The slingshot

Pressing **Ready** ends the building phase: the bricks stop being scenery and
become dynamic bodies, the tray goes away, and a slingshot appears in the
player's hands.

The ergonomics are a real slingshot's, and they follow from giving each hand the
job it actually has:

- **The fork hand aims.** The frame rides on one controller — drawn in metres,
  so it is a life size object in the hand however the board it hangs off is
  scaled — and a stone leaves along the line that runs from the pouch through
  the fork. There is no cursor and no sight.
- **The other hand has to reach for the pouch.** The pouch is not handed over:
  the free hand must come within about 16 cm of it and hold the trigger to take
  hold. Pulling past the end of the bands stops moving the pouch, the way real
  rubber stops stretching.
- **How far it is pulled is how hard the shot is.** Speed is proportional to the
  draw, and the two hands together are the aim and the power
  (`utils/launch.ts`). Letting go of the trigger fires; both hands get a pulse.
  A full pull is fast enough that the arc is nearly flat across a board this
  size, so the shot goes more or less where the fork is pointed rather than
  needing to be lobbed.
- Which hand holds the fork is a button on the panel, because handedness is not
  something to be guessed at.

The stone is dense and has CCD on: at slingshot speeds it covers more than its
own diameter in a step and would otherwise pass clean through a brick without
ever touching it.

### Playing without a headset

Two hands reaching for each other is the one thing an emulator is bad at: the
head follows the mouse, but each hand has to be dragged into place on its own.
So the siege panel has a way round both halves of the gesture, and neither of
them is a different shot — they feed the same arithmetic:

- **Aim: where you look** holds the slingshot out in front of the head instead
  of in a hand. The stone still leaves along the line from the pouch through the
  fork; that line is now the one you are looking down.
- **Hold Space** draws the pouch straight back along the fork, reaching a full
  draw after 1.2 s, and letting go fires. The bands stretch as they would under
  a hand, so how far the pull has got is still there to be seen.

Held by the head, a full draw would put the pouch behind the eye it is being
pulled towards, so the fork goes out as the pouch comes in — half each. It is
also what a drawn bow looks like from behind: one arm out, one hand at the
cheek.

## Winning

A brick is **down** when it is touching the ground — its lowest point, taken
from the axis aligned extent of however it has ended up rotated, is at the
floor. Sitting on top of another brick does not count, whatever height that
happens to be. The castle is beaten when every brick is down *and* the rubble
has stopped moving, so a wall caught mid-collapse does not declare victory a
moment early. The panel counts what is still standing while the siege runs.

"Stopped moving" is asked for four counts in a row, and takes turning into
account as well as travelling. A brick rolling to a halt passes through a moment
of being slow, flat and apparently finished, and can still end up leaning on
another one after it — which is not a castle that is down, and was enough to put
the banner up early once the stone got quick enough to scatter the rubble.

**Back To Building** puts the castle back up exactly as it was built, not as the
rubble left it: the layout is remembered the moment Ready is pressed.

## Physics

Rapier, with gravity `98.1` in board units: a board unit is ten centimetres of
room, so Earth's `9.81 m/s²` is ten units per second squared for every one of
the metre's. Handing Rapier the raw `9.81` — which this app once did — really
means a tenth of gravity, and the castle comes down in the gentle slow motion
of a miniature filmed at scale; scaling it up makes the rubble fall like
rubble. The ground is
placed so its *surface* is the origin's `y = 0`, which is the same arithmetic
the half grid uses: a brick standing on the grid is standing on the floor of the
simulation, with no fudge factor between the two.

While the castle is being built there are no bodies at all — nothing to nudge a
brick, and nothing to simulate. Pressing Ready builds a dynamic body per brick
from its current pose, which is also what makes the first moment of the siege
honest: a castle that was not going to stand up does not stand up.

## Layout of the code

| Path                     | What it is                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| `elements/palette.ts`    | Every colour in the game, panels and world alike.                              |
| `utils/carry.ts`         | Carrying the board about the room without letting it tip over.                 |
| `utils/grid.ts`          | The half grid: rotated extents, corner snapping, and the overlap test.         |
| `utils/launch.ts`        | What a slingshot does when it is let go. Two points in, a shot out.            |
| `utils/rotations.ts`     | The 24 orientations of a cube, alignment to them, stick-driven turns.          |
| `utils/paletteLayout.ts` | Where each brick sits on the tray. A pure function, tested on its own.         |
| `utils/thumbstick.ts`    | Reading a stick as discrete latched steps rather than a continuous value.      |
| `store/CastleStore.ts`   | The castle, its history, and its persistence.                                  |
| `store/Session.ts`       | Which phase the game is in, and the numbers the panel shows.                   |
| `components/Game.ts`     | The board: the drag, the preview, the siege, the count of what is standing.    |
| `components/Brick.ts`    | One brick — mesh, collider, ghost and refused styles, the drag.                |
| `components/Slingshot.ts`| The frame, the bands, the pouch, and the two-handed draw.                      |
| `elements/rapier.ts`     | Rapier bindings: world, colliders, rigid bodies, the fixed-step loop.          |
| `views/`                 | The one panel, projected into the scene; the phase picks which rows it shows.  |

## Things worth picking up next

- **Hand tracking.** The draw is built around controller triggers and poses; a
  pinch and a grip pose would cover most of it, and a slingshot is a gesture
  that would suit hands better than it suits controllers.
- **Something to aim at.** Score by how much of the castle comes down per shot,
  or a fixed number of stones, so that a wild shot costs something.
- **Bricks that break.** A wall that only topples is a blunt instrument; a brick
  that can be knocked in two would make aiming worth doing.
- **A second player.** One builds, one shoots — the phase change is already a
  handover, and the repo has WebRTC signalling for it.
- **More sound.** A brick landing has a click; a stone leaving the pouch and a
  wall coming down both still want one.
