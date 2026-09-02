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

/**
 * The hand holding the brick, and where the brick came from. A drag can be
 * handed from one hand to the other, and only the release of *this* hand ends
 * it — the first hand letting go of a brick that has since been taken over
 * changes nothing. The parent is remembered here rather than on the object,
 * so a handover cannot overwrite it with the hand it was taken from.
 */
interface Hold {
  controller: THREE.Object3D;
  parent: THREE.Object3D;
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
  const hold = Signal.of<Hold | null>(null);
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
      if (!hold.get()) {
        o.position.copy(props.position);
      }
    }),
    // Only a brick that can be picked up is worth pointing at; a ghost that
    // could be hit would swallow rays aimed at what is behind it.
    makeInteractive(() => props.draggable),
    // Held, the brick is a child of the controller, so its world matrix is
    // whatever the hand is doing. The board is told once a frame.
    effects((o) => {
      if (hold.get()) {
        useFrame(ctx, () => emit(props, "dragmove", { matrixWorld: o.matrixWorld }));
      }
    }),
    on("selectstart", (event) => {
      if (!props.draggable) {
        return;
      }
      stopPropagation(event);
      const current = hold.get();
      if (current) {
        if (current.controller === event.controller) {
          return;
        }
        // The other hand taking hold is a handover: the brick moves to the new
        // hand mid-drag and still remembers where it came from.
        hold.set({ controller: event.controller, parent: current.parent });
        event.controller.attach(event.target);
        return;
      }
      const parent = event.target.parent;
      if (!parent) {
        return;
      }
      hold.set({ controller: event.controller, parent });
      event.controller.attach(event.target);
    }),
    on("selectend", (event) => {
      const current = hold.get();
      if (!current) {
        return;
      }
      stopPropagation(event);
      if (current.controller !== event.controller) {
        // Released by a hand that is not the one holding the brick.
        return;
      }
      // Where the brick ended up is read while it is still on the hand; the drag
      // is over once it is back under its own parent, because that is when the
      // effect above puts it back where the props say.
      const matrixWorld = event.target.matrixWorld.clone();
      current.parent.attach(event.target);
      hold.set(null);
      emit(props, "dragend", { matrixWorld });
    }),
  ]);
});

export default Brick;
