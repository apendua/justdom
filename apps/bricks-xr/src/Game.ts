/**
 * The board, and the whole of the game.
 *
 * A brick sits on the plane; dragging it hands over a copy, and the copy lands
 * in whichever cell the hand is over when the trigger is let go. Bricks already
 * placed can be picked up and moved, and carrying one off the grid throws it
 * away. That is all of it.
 */
import * as THREE from "three";
import { children, keyedList, Nothing, $ } from "@apendua/freedom";
import {
  component,
  effects,
  makeNonReactive,
  observeFn,
  on,
  ReactiveMap,
  set,
  Signal,
} from "@apendua/signal";
import Brick from "./Brick.js";
import Panel from "./Panel.js";
import { cellKey, CELL, onBoard, SIZE, snapToCell } from "./grid.js";
import { palette } from "./palette.js";

/** Where the brick that hands out copies sits, in a corner of the board. */
const SOURCE = new THREE.Vector3((SIZE * CELL - CELL) / 2, CELL / 2, (SIZE * CELL - CELL) / 2);

/** What letting go would do: land in a cell, be thrown away, or nothing. */
type Drop = { at: "cell"; key: string; position: THREE.Vector3 } | { at: "outside" | "taken" };

const gridLines = () => {
  const points: number[] = [];
  const edge = (SIZE * CELL) / 2;
  for (let i = 0; i <= SIZE; i++) {
    const offset = i * CELL - edge;
    points.push(-edge, 0, offset, edge, 0, offset, offset, 0, -edge, offset, 0, edge);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  // A whisker above the floor, so the two do not fight over the same pixels.
  return $(
    new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: palette.gridLine })),
    [effects((o) => o.position.set(0, 0.005, 0))],
  );
};

const Game = component((ctx: WeakKey) => {
  /** Cell name to the brick in it. The name is also the "is it free" test. */
  const bricks = new ReactiveMap<string, THREE.Vector3>();
  /** Where the brick in the hand would land, or null if it may not land. */
  const preview = Signal.of<THREE.Vector3 | null>(null);
  const board: { current?: THREE.Object3D } = {};

  /**
   * What would happen if the brick in the hand were let go now. The hand's pose
   * is in the room; the board is scaled and moved about within it, so the pose
   * is put back into the board's own coordinates before it is snapped.
   *
   * `from` is the cell a brick was picked up out of, which does not count as
   * taken — a brick put back where it came from has not gone anywhere.
   */
  const evaluate = makeNonReactive((matrixWorld: THREE.Matrix4, from?: string): Drop => {
    if (!board.current) {
      return { at: "outside" };
    }
    const local = new THREE.Matrix4()
      .copy(matrixWorld)
      .premultiply(board.current.matrixWorld.clone().invert());
    const position = snapToCell(new THREE.Vector3().setFromMatrixPosition(local));
    if (!onBoard(position)) {
      return { at: "outside" };
    }
    const key = cellKey(position);
    // The corner the source brick stands in is never free.
    if (key === cellKey(SOURCE) || (bricks.has(key) && key !== from)) {
      return { at: "taken" };
    }
    return { at: "cell", key, position };
  });

  /** The ghost shows the cell a brick would land in, and only when it would. */
  const showPreview = (matrixWorld: THREE.Matrix4, from?: string) => {
    const drop = evaluate(matrixWorld, from);
    preview.set(drop.at === "cell" ? drop.position : null);
  };

  return $(new THREE.Group(), [
    effects((o) => {
      board.current = o;
    }),
    children(
      gridLines(),

      // The brick on the plane. It never moves: letting go puts it back, and
      // what lands on the board is a copy.
      Brick(ctx, [
        set({ position: SOURCE, draggable: true }),
        on("dragmove", (event) => showPreview(event.matrixWorld)),
        on("dragend", (event) => {
          const drop = evaluate(event.matrixWorld);
          preview.set(null);
          if (drop.at === "cell") {
            bricks.set(drop.key, drop.position);
          }
        }),
      ]),

      // The brick that would be placed if the trigger were let go now.
      component(() => {
        const position = preview.get();
        if (!position) {
          return Nothing();
        }
        return Brick(ctx, [set({ ghost: true, position })]);
      })(),

      keyedList(
        observeFn(bricks).entries(),
        component((position: THREE.Vector3, key: string) => {
          return Brick(ctx, [
            set({ position, draggable: true }),
            on("dragmove", (event) => showPreview(event.matrixWorld, key)),
            on("dragend", (event) => {
              const drop = evaluate(event.matrixWorld, key);
              preview.set(null);
              if (drop.at === "cell") {
                bricks.delete(key);
                bricks.set(drop.key, drop.position);
              } else if (drop.at === "outside") {
                bricks.delete(key);
              }
              // Let go over a cell that is taken: the brick stays where it was.
            }),
          ]);
        }),
      ),

      Panel(ctx, [
        effects((panel) => {
          panel.bricks = bricks.size;
        }),
        on("reset", () => bricks.clear()),
      ]),
    ),
  ]);
});

export default Game;
