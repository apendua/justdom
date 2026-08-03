import { Signal } from "@apendua.dev/signal";
import * as THREE from "three";
import {
  effects,
  use,
  on,
  set,
  just,
  store,
  Op,
  emit,
  component,
  effectMap,
  onCleanup,
} from "@apendua.dev/signal";
import {
  $,
  children,
  animate,
  interactions,
  Nothing,
  setLocalMatrix,
  XREventMap,
} from "@apendua.dev/three";
import { NEVER } from "rxjs";
import * as RAPIER from "@dimforge/rapier3d";
import { BrickStyle, brickShape, BrickType } from "./types.js";
import { PointersContext } from "../elements/context.js";
import { boxGeometry, wedgeCorners, wedgeGeometry } from "../elements/geometry.js";
import { brickMaterial, ghostMaterial, invisibleMaterial } from "../elements/material.js";
import { collider, rigidBody } from "../elements/rapier.js";
import { palette } from "../elements/palette.js";

/** How heavy a brick is for its size. Stone, near enough. */
const BRICK_DENSITY = 1.4;
const BRICK_FRICTION = 0.8;
const BRICK_RESTITUTION = 0.02;

const GHOST_COLOUR = palette.ghost;
const BLOCKED_COLOUR = palette.refused;

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
 * A drag started with the grip button leaves the brick where it is and hands
 * out a copy instead, so the quickest way to get another brick of some kind is
 * to pull it off one that is already in the castle.
 */
interface DragState {
  inputSource: XRInputSource;
  clone: boolean;
}

interface DragStartEvent extends DragState {
  matrixWorld: THREE.Matrix4;
}

interface DragEndEvent extends DragState {
  reset: () => void;
  matrixWorld: THREE.Matrix4;
}

interface DragMoveEvent extends DragState {
  matrixWorld: THREE.Matrix4;
}

/**
 * The parts of a select/squeeze event a drag actually needs. Both the "start"
 * and the "end" flavours of those events carry them.
 */
interface DragTrigger {
  target: THREE.Object3D<XREventMap>;
  controller: THREE.Object3D;
  inputSource: XRInputSource;
}

function brickGeometry(type: BrickType): THREE.BufferGeometry {
  const { size, profile } = brickShape(type);
  const [x, y, z] = size;
  return profile === "wedge" ? wedgeGeometry(x, y, z) : boxGeometry(x, y, z);
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
      return ghostMaterial(GHOST_COLOUR);
    case "blocked":
      return ghostMaterial(BLOCKED_COLOUR);
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
  const dragState = Signal.of<DragState | null>(null);
  const { makeInteractive, stopPropagation } = interactions(ctx);

  const placeAt = (o: THREE.Object3D) => {
    o.position.copy(props.position);
    o.rotation.copy(props.rotation);
    o.scale.set(props.scale, props.scale, props.scale);
  };

  const startDrag = (event: DragTrigger, clone: boolean) => {
    if (dragState.get()) {
      // Already being dragged with the other button.
      return;
    }
    event.target.userData.oldParent = event.target.parent;
    event.target.userData.oldMatrix = new THREE.Matrix4().copy(event.target.matrix);
    emit(props, "dragstart", {
      matrixWorld: event.target.matrixWorld.clone(),
      inputSource: event.inputSource,
      clone,
    });
    dragState.set({ inputSource: event.inputSource, clone });
    event.controller.attach(event.target);
  };

  const endDrag = (event: DragTrigger, clone: boolean) => {
    const drag = dragState.get();
    if (!drag || drag.clone !== clone) {
      // Released a button that did not start this drag.
      return;
    }
    if (event.target.userData.oldParent && event.target.parent === event.controller) {
      const oldMatrix = event.target.userData.oldMatrix.clone();
      const dragEvent = {
        matrixWorld: event.target.matrixWorld.clone(),
        inputSource: drag.inputSource,
        clone: drag.clone,
        reset: () => {
          setLocalMatrix(event.target, oldMatrix);
        },
      };
      event.target.userData.oldParent.attach(event.target);
      event.target.userData.oldParent = null;
      event.target.userData.oldMatrix = null;
      emit(props, "dragend", dragEvent);
    }
    dragState.set(null);
  };

  return $(new THREE.Group<XREventMap>(), [
    effects(() => {
      use(just(props, operators));
    }),
    effects((o) => {
      placeAt(o);
    }),
    effectMap((o) => {
      if (dragState.get() || props.bodyType === null) {
        return NEVER;
      }
      // The body takes its pose from the object when it is built and then
      // drives the object every frame, so a brick that is moved by anything
      // other than the simulation needs its body built again — and needs to be
      // sitting in the right place first, whichever effect runs before which.
      placeAt(o);
      const type = props.type;
      return just(o, [
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
      const drag = dragState.get();
      if (drag) {
        use(
          animate(ctx, () => {
            emit(props, "dragmove", {
              matrixWorld: o.matrixWorld,
              inputSource: drag.inputSource,
              clone: drag.clone,
            });
          }),
        );
      }
    }),
    effectMap((o) => {
      if (!props.interactive) {
        return NEVER;
      }
      return just(o, [makeInteractive(), PointersContext.get(ctx)]);
    }),
    on("selectstart", (event) => {
      if (!props.draggable) {
        return;
      }
      stopPropagation(event);
      startDrag(event, false);
    }),
    on("selectend", (event) => {
      if (!dragState.get() && !props.draggable) {
        return;
      }
      stopPropagation(event);
      endDrag(event, false);
    }),
    on("squeezestart", (event) => {
      if (!props.draggable) {
        return;
      }
      stopPropagation(event);
      startDrag(event, true);
    }),
    on("squeezeend", (event) => {
      if (!dragState.get() && !props.draggable) {
        return;
      }
      stopPropagation(event);
      endDrag(event, true);
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
