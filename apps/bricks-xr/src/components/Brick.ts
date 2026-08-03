/**
 * One brick, and the drag that carries it.
 *
 * A drag is three events: it starts when the trigger goes down on the brick,
 * reports where the brick is on every frame while it is held, and ends when the
 * trigger comes up. Where the brick actually *goes* is not decided here — the
 * board decides that, from the pose reported in the event — which is what lets
 * the same component be the brick you pick up, the copy you are carrying and the
 * ghost showing where it would land.
 */
import * as THREE from "three";
import {
  component,
  effectMap,
  effects,
  emit,
  just,
  on,
  Op,
  set,
  Signal,
  store,
  use,
} from "@apendua.dev/signal";
import { $, animate, interactions, XREventMap } from "@apendua.dev/three";
import { NEVER } from "rxjs";
import { CELL } from "../utils/grid.js";
import { PointersContext } from "../elements/context.js";
import { boxGeometry } from "../elements/geometry.js";
import { brickMaterial, ghostMaterial } from "../elements/material.js";
import { palette } from "../elements/palette.js";

interface Props {
  position: THREE.Vector3;
  /** A ghost is the brick as it would land: see-through, and not pointable. */
  ghost: boolean;
  draggable: boolean;
}

interface DragEvent {
  /** Where the brick is in the room, which is all the board needs to place it. */
  matrixWorld: THREE.Matrix4;
}

interface Events {
  dragstart: DragEvent;
  dragmove: DragEvent;
  dragend: DragEvent;
}

const defaults: Props = {
  position: new THREE.Vector3(),
  ghost: false,
  draggable: false,
};

const Brick = component((ctx: WeakKey, operators: Op<Props, Events>) => {
  const props = store<Props, Events>(defaults, operators);
  const dragging = Signal.of(false);
  const { makeInteractive, stopPropagation } = interactions(ctx);

  return $(new THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>(), [
    effects(() => {
      use(just(props, operators));
    }),
    // While a brick is held it belongs to the hand, and the hand's own movement
    // is what places it. Every other frame its position comes from the props —
    // including the frame it is let go on, which is what puts a brick back where
    // it came from when the board refuses the drop.
    effects((o) => {
      if (dragging.get()) {
        return;
      }
      o.position.copy(props.position);
    }),
    // A ghost must never swallow a ray aimed at what is behind it.
    effectMap((o) => {
      if (props.ghost) {
        return NEVER;
      }
      return just(o, [makeInteractive(), PointersContext.get(ctx)]);
    }),
    // While the brick is held it is a child of the controller, so its world
    // matrix is whatever the hand is doing. The board is told about it once a
    // frame and works out which cell that is.
    effects((o) => {
      if (dragging.get()) {
        use(
          animate(ctx, () => {
            emit(props, "dragmove", { matrixWorld: o.matrixWorld });
          }),
        );
      }
    }),
    on("selectstart", (event) => {
      if (!props.draggable) {
        return;
      }
      stopPropagation(event);
      event.target.userData.oldParent = event.target.parent;
      emit(props, "dragstart", { matrixWorld: event.target.matrixWorld.clone() });
      dragging.set(true);
      event.controller.attach(event.target);
    }),
    on("selectend", (event) => {
      if (!dragging.get()) {
        return;
      }
      stopPropagation(event);
      const { oldParent } = event.target.userData;
      if (!oldParent || event.target.parent !== event.controller) {
        return;
      }
      // Where the brick ended up is read while it is still on the hand, and the
      // drag is only declared over once it is back under its own parent — the
      // effect above puts it where the props say the moment that happens, and
      // that has to be somewhere the props are meaningful.
      const matrixWorld = event.target.matrixWorld.clone();
      oldParent.attach(event.target);
      event.target.userData.oldParent = null;
      dragging.set(false);
      emit(props, "dragend", { matrixWorld });
    }),
    set({
      get geometry() {
        return boxGeometry(CELL, CELL, CELL);
      },
      get material() {
        return props.ghost ? ghostMaterial(palette.ghost) : brickMaterial(palette.brick);
      },
    }),
  ]);
});

export default Brick;
