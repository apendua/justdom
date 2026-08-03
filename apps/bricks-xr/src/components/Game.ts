/**
 * The board, and the whole of the game.
 *
 * A brick sits on the plane; dragging it hands over a copy, and the copy lands
 * in whichever cell the hand is over when the trigger is let go. Bricks already
 * placed can be picked up and moved, and carrying one off the grid throws it
 * away. That is all of it.
 *
 * The bricks are held in a map **keyed by the cell they are in**, so the key
 * says both where a brick is and whether that space is taken: placing is a set,
 * moving is a delete and a set, and "is this cell free" is a lookup. No
 * geometry is ever compared with any other geometry.
 */
import * as THREE from "three";
import { children, keyedList, Nothing, $ } from "@apendua.dev/three";
import {
  component,
  effects,
  makeNonReactive,
  observeFn,
  on,
  ReactiveMap,
  set,
  store,
} from "@apendua.dev/signal";
import Brick from "./Brick.js";
import Grid from "./Grid.js";
import Panel from "../views/Panel.js";
import { cellKey, CELL, snapToCell } from "../utils/grid.js";

/** The board is this many cells across, centred on the origin. */
const SIZE = 10;
const HALF = (SIZE * CELL) / 2;

/** Where the brick that hands out copies sits, in a corner of the board. */
const SOURCE_POSITION = new THREE.Vector3(HALF - CELL / 2, CELL / 2, HALF - CELL / 2);
/** Its cell is never free: it is where you go to get another brick. */
const SOURCE_CELL = cellKey(SOURCE_POSITION);

/** What a released brick may do: land in a cell, be thrown away, or nothing. */
type Drop =
  | { at: "cell"; key: string; position: THREE.Vector3 }
  | { at: "outside" }
  | { at: "taken" };

const Game = component((ctx: WeakKey) => {
  /** Cell key to the position of the brick in it. */
  const bricks = new ReactiveMap<string, THREE.Vector3>();
  const preview = store<{ position: THREE.Vector3; visible: boolean }>({
    position: new THREE.Vector3(),
    visible: false,
  });
  const board: { current?: THREE.Object3D } = {};

  /**
   * What would happen if the brick in the hand were let go now. The hand's pose
   * is in the room; the board is scaled and moved about within it, so the pose
   * is put back into the board's own coordinates before it is snapped to a cell.
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
    if (Math.abs(position.x) > HALF || Math.abs(position.z) > HALF || position.y > HALF * 2) {
      return { at: "outside" };
    }
    const key = cellKey(position);
    if (key === SOURCE_CELL || (bricks.has(key) && key !== from)) {
      return { at: "taken" };
    }
    return { at: "cell", key, position };
  });

  /** The ghost shows the cell a brick would land in, and only when it would. */
  const showPreview = makeNonReactive((matrixWorld: THREE.Matrix4, from?: string) => {
    const drop = evaluate(matrixWorld, from);
    if (drop.at === "cell") {
      preview.position = drop.position;
    }
    preview.visible = drop.at === "cell";
  });

  const hidePreview = makeNonReactive(() => {
    preview.visible = false;
  });

  return $(new THREE.Group(), [
    effects((o) => {
      board.current = o;
    }),
    children(
      Grid(ctx, [set({ size: SIZE, cellWidth: CELL })]),

      // The brick on the plane. It never moves: a drag puts it back where it
      // was and leaves a copy wherever the hand let go.
      Brick(ctx, [
        set({ position: SOURCE_POSITION, draggable: true }),
        on("dragmove", (event) => {
          showPreview(event.matrixWorld);
        }),
        on("dragend", (event) => {
          const drop = evaluate(event.matrixWorld);
          hidePreview();
          // The brick on the plane stays where it is: letting go puts it back,
          // and what lands on the board is a copy.
          if (drop.at === "cell") {
            bricks.set(drop.key, drop.position);
          }
        }),
      ]),

      // The brick that would be placed if the trigger were let go now.
      component(() => {
        if (!preview.visible) {
          return Nothing();
        }
        return Brick(ctx, [
          set({
            ghost: true,
            get position() {
              return preview.position;
            },
          }),
        ]);
      })(),

      keyedList(
        observeFn(bricks).entries(),
        component((position: THREE.Vector3, key: string) => {
          return Brick(ctx, [
            set({ position, draggable: true }),
            on("dragmove", (event) => {
              showPreview(event.matrixWorld, key);
            }),
            on("dragend", (event) => {
              const drop = evaluate(event.matrixWorld, key);
              hidePreview();
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
        set({
          position: new THREE.Vector3(-HALF - 4, HALF, 2),
          rotation: new THREE.Euler(0, Math.PI / 8, 0),
        }),
        effects((panel) => {
          panel.bricks = bricks.size;
        }),
        on("reset", () => {
          bricks.clear();
        }),
      ]),
    ),
  ]);
});

export default Game;
