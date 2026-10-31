/**
 * One brick, and the drag that carries it.
 *
 * A brick does not know where it goes. It says where it is on every frame it is
 * held, and again when it is let go, and the board decides what that means —
 * which is why the same component is the brick you pick up, the copy in your
 * hand, and the ghost of where it would land.
 */
import * as THREE from "three";
import { component, effects, emit, on, Op, set, store } from "justdom-signal";
import { $, drag, interactions, XREventMap } from "justdom-three";
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
  const { makeInteractive } = interactions(ctx);
  // The carrying itself — which hand has the brick, handing it to the other
  // one, putting it back — is freedom's. What a brick adds is what the board
  // makes of where it is.
  const { draggable, held } = drag(ctx, { enabled: () => props.draggable });

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
      if (!held()) {
        o.position.copy(props.position);
      }
    }),
    // Only a brick that can be picked up is worth pointing at; a ghost that
    // could be hit would swallow rays aimed at what is behind it.
    makeInteractive(() => props.draggable),
    draggable(),
    // Held, the brick is a child of the controller, so its world matrix is
    // whatever the hand is doing. The board is told once a frame, and once
    // more when the brick is let go.
    on("dragmove", (event) => emit(props, "dragmove", { matrixWorld: event.matrixWorld })),
    on("dragend", (event) => emit(props, "dragend", { matrixWorld: event.matrixWorld })),
  ]);
});

export default Brick;
