# Bricks XR

Grab a brick, drop it on the grid, build something. That is the whole game.

This is [castle-xr](../castle-xr/README.md) with everything taken out of it: no
physics, no slingshot, no music, no saving, one kind of brick and no tray to pick
it from. What is left is the part worth reading — a reactive scene, a drag that
starts on a controller trigger, and a panel of ordinary DOM projected into the
room — in **five files and 400 lines**, against castle-xr's thirty files and
3400. It is meant to be read start to finish before writing an XR app of your
own.

```
rush build --to @apendua.dev/bricks-xr
cd apps/bricks-xr && npm run dev
```

Open the printed `https://` URL in a headset browser and press **Start AR**
(it falls back to plain VR on a headset without passthrough), or
add `?emulator` to run it in an ordinary browser with the
[iwer](https://github.com/meta-quest/immersive-web-emulation-runtime) emulator
(`?emulator=bare` leaves the DevUI out, for driving it from a script).

| Input                   | What happens                  |
| ----------------------- | ----------------------------- |
| Trigger on the brick    | Picks it up                   |
| Let go over the grid    | Places it in that cell        |
| Let go off the grid     | Throws it away                |
| Trigger on a placed one | Picks it up again, to move it |
| **Reset**               | Back to an empty board        |

One brick sits on the plane and never leaves it: dragging that one hands over a
copy. There is nothing to save, so reloading starts you over.

## The five files

| File        | Lines | What it is                                                     |
| ----------- | ----: | -------------------------------------------------------------- |
| `grid.ts`   |    35 | Where a brick may go. Pure functions, so `grid.test.ts` is easy. |
| `Brick.ts`  |   116 | One brick, and the drag that carries it.                        |
| `Game.ts`   |   148 | The board: the rules, the ghost, the bricks, the panel.         |
| `Panel.ts`  |    85 | The interface, as DOM.                                          |
| `App.ts`    |    51 | The scene: floor, light, and where the board floats.            |

Plus `main.ts` to mount it, `emulator.ts` to fake a headset, and `palette.ts` so
the colours live in one place.

## The four ideas in it

**The cell is the identity.** A brick fills one cell, so the bricks live in a
`ReactiveMap` keyed by the cell they are in. The key says both where a brick is
and whether that space is taken: placing is a `set`, moving is a `delete` and a
`set`, and "may this go here" is a lookup. No geometry is ever compared with any
other geometry, and there is no collision test in the app at all. Snapping is the
other half of the same idea — the centre of the nearest cell, never below the
floor.

**A brick does not know where it goes.** It says where it is on every frame it is
held, and again when it is let go, and the board decides what that means. That is
why the same component is the brick you pick up, the copy in your hand, and the
see-through ghost of where it would land.

While a brick is held it is a child of the controller, so the hand's own movement
is what moves it. Its position comes from its props on every *other* frame,
including the one it is let go on — which is what puts a brick back where it came
from when the board refuses the drop. Get that ordering wrong and a refused brick
stays stuck to your hand: it is the one subtle thing in the file, and it is
commented as such.

**The board owns the rules.** One function says what a release would do — land in
a cell, be thrown away, or nothing — and the ghost is shown only when the answer
is "land in a cell", so a preview never promises a placement that will not
happen. The hand's pose arrives in room coordinates; the board is scaled and
moved about within the room, so the pose is put back into the board's own
coordinates before anything is decided.

**The panel is a web page.** Real `div`s with real stylesheets, projected into
the scene by `dom()` and clicked by pointing a controller at them. No 3D
interface toolkit is involved.

## What was left out, and where to find it

All of this is in castle-xr, and none of it is needed to build with bricks:

- **Physics** — Rapier, dynamic bodies, and a win condition that watches the
  rubble settle.
- **More than one brick, and turning them** — several sizes means snapping the
  *corner* of a brick to a half grid rather than a brick to a cell, and rotations
  mean the 24 orientations of a cube and a thumbstick to reach them.
- **A tray to pick bricks from**, laid out by a pure function.
- **Undo and redo**, recorded as what a brick looked like before and after.
- **Saving**, to `localStorage`.
- **Sound**, and a dot drawn where each controller's ray lands.
