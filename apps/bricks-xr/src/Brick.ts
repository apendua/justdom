/**
 * One brick, and the drag that carries it.
 *
 * A brick does not know where it goes. It says where it is on every frame it is
 * held, and again when it is let go, and the board decides what that means —
 * which is why the same component is the brick you pick up, the copy in your
 * hand, and the ghost of where it would land.
 */
import * as THREE from "three";
import { component, effects, emit, on, Op, set, Signal, store } from "@apendua/signal";
import { $, interactions, useFrame, XREventMap } from "@apendua/freedom";
import { CELL } from "./grid.js";
import { palette } from "./palette.js";

interface Props {
  position: THREE.Vector3;
  /** A ghost is the brick as it would land: see-through, and not pointable. */
  ghost: boolean;
  draggable: boolean;
}

/** Where the brick is in the room, which is all the board needs. */
interface DragEvent {
  matrixWorld: THREE.Matrix4;
}

interface Events {
  dragmove: DragEvent;
  dragend: DragEvent;
}

const geometry = new THREE.BoxGeometry(CELL, CELL, CELL);
const solid = new THREE.MeshPhongMaterial({
  color: palette.brick,
  flatShading: true,
  shininess: 8,
});
const ghostly = new THREE.MeshPhongMaterial({
  color: palette.ghost,
  flatShading: true,
  transparent: true,
  opacity: 0.45,
  depthWrite: false,
});

const Brick = component((ctx: WeakKey, operators: Op<Props, Events>) => {
  const props = store<Props, Events>(
    { position: new THREE.Vector3(), ghost: false, draggable: false },
    operators,
  );
  const held = Signal.of(false);
  const { makeInteractive, stopPropagation } = interactions(ctx);

  return $(new THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>(), [
    set({
      geometry,
      get material() {
        return props.ghost ? ghostly : solid;
      },
    }),
    // While a brick is held it belongs to the hand, and the hand's own movement
    // is what places it. Every other frame its position comes from the props —
    // including the frame it is let go on, which is what puts a brick back where
    // it came from when the board refuses the drop.
    effects((o) => {
      if (!held.get()) {
        o.position.copy(props.position);
      }
    }),
    // Only a brick that can be picked up is worth pointing at; a ghost that
    // could be hit would swallow rays aimed at what is behind it.
    makeInteractive(() => props.draggable),
    // Held, the brick is a child of the controller, so its world matrix is
    // whatever the hand is doing. The board is told once a frame.
    effects((o) => {
      if (held.get()) {
        useFrame(ctx, () => emit(props, "dragmove", { matrixWorld: o.matrixWorld }));
      }
    }),
    on("selectstart", (event) => {
      if (!props.draggable) {
        return;
      }
      stopPropagation(event);
      event.target.userData.parent = event.target.parent;
      held.set(true);
      event.controller.attach(event.target);
    }),
    on("selectend", (event) => {
      const parent = event.target.userData.parent;
      if (!held.get() || !parent) {
        return;
      }
      stopPropagation(event);
      // Where the brick ended up is read while it is still on the hand; the drag
      // is over once it is back under its own parent, because that is when the
      // effect above puts it back where the props say.
      const matrixWorld = event.target.matrixWorld.clone();
      parent.attach(event.target);
      event.target.userData.parent = null;
      held.set(false);
      emit(props, "dragend", { matrixWorld });
    }),
  ]);
});

export default Brick;
