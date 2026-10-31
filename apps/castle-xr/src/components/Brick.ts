import * as THREE from "three";
import {
  effects,
  useEffects,
  on,
  set,
  store,
  Op,
  emit,
  component,
  onCleanup,
} from "@apendua/signal";
import { $, children, drag, interactions, Nothing, XREventMap } from "@apendua/freedom";
import * as RAPIER from "@dimforge/rapier3d";
import { BrickStyle, brickShape, BrickType } from "./types.js";
import {
  bevelledBoxGeometry,
  bevelledWedgeGeometry,
  boxGeometry,
  wedgeCorners,
} from "../elements/geometry.js";
import { brickMaterial, ghostMaterial, invisibleMaterial } from "../elements/material.js";
import { collider, rigidBody } from "../elements/rapier.js";
import { palette } from "../elements/palette.js";

/** How heavy a brick is for its size. Stone, near enough. */
const BRICK_DENSITY = 1.4;
const BRICK_FRICTION = 0.8;
const BRICK_RESTITUTION = 0.02;

/**
 * How much of an edge each brick gives up to its chamfer, in board units. Just
 * enough for a seam of shaded bevel between two stacked bricks — it is what
 * lets one brick be told from the next when they sit flush. Drawing only: the
 * colliders keep the sharp corners, so bricks still stack without slivers of
 * gap in the simulation.
 */
const BRICK_BEVEL = 0.04;

interface Props {
  bodyType: RAPIER.RigidBodyType | null;
  type: BrickType;
  style: BrickStyle;
  scale: number;
  position: THREE.Vector3;
  rotation: THREE.Euler;
  draggable: boolean;
  /**
   * Whether the brick can be pointed at. Previews are turned off so that they
   * never swallow a ray aimed at whatever is behind them.
   */
  interactive: boolean;
  /**
   * Makes the whole cell the brick occupies pointable. Bricks laid out on the
   * tray need this: the thin ones are awkward to aim at, and a palette is no
   * place to have to aim carefully.
   */
  hitbox: boolean;
}

interface Events {
  dragstart: DragStartEvent;
  dragend: DragEndEvent;
  dragmove: DragMoveEvent;
  bodycreated: { body: RAPIER.RigidBody };
  bodyremoved: { body: RAPIER.RigidBody };
}

/**
 * What the board is told about a drag: where the brick is, which hand has it
 * — its gamepad is where the thumbstick is read from — and whether it is a
 * move or a copy. A drag started with the grip button leaves the brick where
 * it is and hands out a copy instead, so the quickest way to get another brick
 * of some kind is to pull it off one that is already in the castle.
 */
interface DragEvent {
  matrixWorld: THREE.Matrix4;
  inputSource: XRInputSource;
  clone: boolean;
}

interface DragStartEvent extends DragEvent {}

interface DragEndEvent extends DragEvent {
  reset: () => void;
}

interface DragMoveEvent extends DragEvent {}

function brickGeometry(type: BrickType): THREE.BufferGeometry {
  const { size, profile } = brickShape(type);
  const [x, y, z] = size;
  return profile === "wedge"
    ? bevelledWedgeGeometry(x, y, z, BRICK_BEVEL)
    : bevelledBoxGeometry(x, y, z, BRICK_BEVEL);
}

function brickColliderDesc(type: BrickType): RAPIER.ColliderDesc | null {
  const { size, profile } = brickShape(type);
  const [x, y, z] = size;
  const desc =
    profile === "wedge"
      ? RAPIER.ColliderDesc.convexHull(new Float32Array(wedgeCorners(x, y, z).flat()))
      : RAPIER.ColliderDesc.cuboid(x / 2, y / 2, z / 2);
  return (
    desc?.setDensity(BRICK_DENSITY).setFriction(BRICK_FRICTION).setRestitution(BRICK_RESTITUTION) ??
    null
  );
}

function brickMaterialFor(type: BrickType, style: BrickStyle): THREE.Material {
  switch (style) {
    case "ghost":
      return ghostMaterial(palette.ghost);
    case "blocked":
      return ghostMaterial(palette.refused);
    default:
      return brickMaterial(brickShape(type).colour);
  }
}

const Brick = component((ctx: WeakKey, operators: Op<Props, Events>) => {
  const props = store<Props, Events>({
    bodyType: null,
    type: "cube",
    style: "normal",
    scale: 1,
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0),
    draggable: false,
    interactive: true,
    hitbox: false,
  });
  const { makeInteractive } = interactions(ctx);
  // The carrying itself — which hand has the brick, handing it to the other
  // one, putting it back — is freedom's. What a brick adds is its size in the
  // hand, which button means a copy, and what the board makes of where it is.
  const { draggable, held } = drag(ctx, {
    buttons: ["select", "squeeze"],
    enabled: () => props.draggable,
  });
  /**
   * Whether the drag under way is handing out a copy. Decided by the button
   * it started with and kept through a handover: a move stays a move and a
   * copy stays a copy, whichever button the new hand grabbed with.
   */
  let clone = false;

  const placeAt = (o: THREE.Object3D) => {
    o.position.copy(props.position);
    o.rotation.copy(props.rotation);
    o.scale.set(props.scale, props.scale, props.scale);
  };

  return $(new THREE.Group<XREventMap>(), [
    effects(() => {
      useEffects(props, operators);
    }),
    // While a brick is held it belongs to the hand, and the hand's own movement
    // is what places it. Every other frame its pose comes from the props —
    // including the frame it is let go on, which is what puts a brick back where
    // it came from when the board refuses the drop. Reading the hold here is
    // what makes that last part happen, so it is not as redundant as it looks.
    effects((o) => {
      if (held()) {
        return;
      }
      placeAt(o);
    }),
    effects((o) => {
      if (held() || props.bodyType === null) {
        return;
      }
      // The body takes its pose from the object when it is built and then
      // drives the object every frame, so a brick that is moved by anything
      // other than the simulation needs its body built again — and needs to be
      // sitting in the right place first, whichever effect runs before which.
      placeAt(o);
      const type = props.type;
      useEffects(o, [
        rigidBody(ctx, props.bodyType, [
          collider(ctx, () => brickColliderDesc(type)),
          effects((body) => {
            emit(props, "bodycreated", { body });
            onCleanup(() => {
              emit(props, "bodyremoved", { body });
            });
          }),
        ]),
      ]);
    }),
    effects((o) => {
      if (props.interactive) {
        useEffects(o, [makeInteractive()]);
      }
    }),
    draggable(),
    on("dragstart", (event) => {
      clone = event.button === "squeeze";
      emit(props, "dragstart", {
        matrixWorld: event.matrixWorld,
        inputSource: event.inputSource,
        clone,
      });
      // A brick on the tray is shown small to keep the row within reach, but
      // what the player has taken hold of is the brick, not the miniature: it
      // comes up to the size it will actually be on the board the moment it is
      // picked, so the hand is aiming with the real thing. Once, for the whole
      // drag: a handover is not a second pick-up.
      if (props.scale !== 1) {
        event.target.scale.multiplyScalar(1 / props.scale);
      }
    }),
    // Held, the brick is a child of the controller, so its world matrix is
    // whatever the hand is doing. The board is told once a frame, and once
    // more when the brick is let go.
    on("dragmove", (event) => {
      emit(props, "dragmove", {
        matrixWorld: event.matrixWorld,
        inputSource: event.inputSource,
        clone,
      });
    }),
    on("dragend", (event) => {
      emit(props, "dragend", {
        matrixWorld: event.matrixWorld,
        inputSource: event.inputSource,
        clone,
        reset: event.reset,
      });
    }),
    children(
      component(() => {
        if (!props.hitbox) {
          return Nothing();
        }
        const [x, y, z] = brickShape(props.type).size;
        return $(new THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>(), [
          set({
            get geometry() {
              return boxGeometry(Math.max(x, 0.8), Math.max(y, 0.8), Math.max(z, 0.8));
            },
            get material() {
              return invisibleMaterial();
            },
          }),
        ]);
      })(),
      $(new THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>(), [
        set({
          get geometry() {
            return brickGeometry(props.type);
          },
          get material() {
            return brickMaterialFor(props.type, props.style);
          },
        }),
      ]),
    ),
  ]);
});

export default Brick;
