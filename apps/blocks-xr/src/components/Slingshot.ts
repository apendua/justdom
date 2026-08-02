/**
 * The slingshot.
 *
 * The ergonomics are the ones a real slingshot has, and they fall out of using
 * both hands for what each is actually for. One hand holds the fork: it decides
 * where the shot goes, because a stone leaves along the line that runs from the
 * pouch through the fork. The other hand takes the pouch — it has to reach for
 * it, the pouch is not simply handed over — and how far it pulls decides how
 * hard the shot is. Nothing is aimed by pointing, and there is no power meter:
 * the two hands are the aim and the power.
 *
 * The fork is drawn in metres and follows the controller in the room, so it is
 * a real object in the hand rather than something living in the board's scale.
 * The shot itself is worked out in the board's coordinates, because that is
 * where the stone has to fly.
 */
import * as THREE from "three";
import { component, effects, emit, makeNonReactive, Op, store, use } from "@apendua.dev/signal";
import {
  $,
  animate,
  children,
  controllers,
  setWorldMatrix,
  ControllerHandle,
} from "@apendua.dev/three";
import { cylinderGeometry, sphereGeometry } from "../elements/geometry.js";
import { basicMaterial, stoneMaterial } from "../elements/material.js";
import { clampDraw, computeLaunch, defaultLaunchOptions } from "../utils/launch.js";
import { worldOrigin } from "../elements/rapier.js";
import { ForkHand } from "../store/Session.js";

interface Props {
  forkHand: ForkHand;
}

interface Events {
  /** A stone leaving the pouch, in the board's coordinates. */
  shoot: { position: THREE.Vector3; velocity: THREE.Vector3 };
}

const defaults: Props = {
  forkHand: "left",
};

/** The trigger, in the xr-standard gamepad mapping. */
const TRIGGER = 0;

// The frame of the slingshot, in metres, relative to the controller: the
// handle sits in the fist, the fork opens out ahead of it, and the bands meet
// where the controller is pointing.
const HANDLE_BOTTOM = new THREE.Vector3(0, -0.03, 0.04);
const YOKE = new THREE.Vector3(0, 0.01, -0.04);
const TIP_LEFT = new THREE.Vector3(-0.05, 0.03, -0.13);
const TIP_RIGHT = new THREE.Vector3(0.05, 0.03, -0.13);
/** Where the pouch sits when it is not being pulled: between the two tips. */
const POUCH_REST = new THREE.Vector3(0, 0.03, -0.13);

const FRAME_RADIUS = 0.011;
const BAND_RADIUS = 0.005;
const STONE_RADIUS = 0.022;
const FRAME_COLOUR = "#6b4a2f";
const BAND_COLOUR = "#2b2b2b";

/**
 * How close the free hand has to come to the pouch to take hold of it, in board
 * units. Generous enough to be found without looking, small enough that the
 * player has to actually reach for the fork.
 */
const CAPTURE_RADIUS = 1.6;

const UP = new THREE.Vector3(0, 1, 0);

interface HapticActuator {
  pulse?: (intensity: number, duration: number) => Promise<boolean>;
}

function pulse(handle: ControllerHandle | undefined, intensity: number, duration: number) {
  const actuators = handle?.inputSource.get()?.gamepad?.hapticActuators as
    | HapticActuator[]
    | undefined;
  void actuators?.[0]?.pulse?.(intensity, duration);
}

function triggerPressed(handle: ControllerHandle | undefined): boolean {
  return handle?.inputSource.get()?.gamepad?.buttons?.[TRIGGER]?.pressed ?? false;
}

/** Where the fist is: the grip space if the runtime offers one, else the ray. */
function handPosition(handle: ControllerHandle): THREE.Vector3 {
  const space = handle.grip.visible ? handle.grip : handle.controller;
  space.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(space.matrixWorld);
}

/** Lays a unit cylinder along the segment between two points. */
function setSegment(object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  const along = to.clone().sub(from);
  const length = along.length();
  object.position.copy(from).addScaledVector(along, 0.5);
  if (length > 1e-6) {
    object.quaternion.setFromUnitVectors(UP, along.divideScalar(length));
  }
  object.scale.set(1, Math.max(length, 1e-6), 1);
}

type Ref = { current?: THREE.Object3D };

const Slingshot = component((ctx: WeakKey, operators: Op<Props, Events>) => {
  const props = store<Props, Events>(defaults, operators);
  const hands = controllers(ctx);

  const pouch: Ref = {};
  const leftBand: Ref = {};
  const rightBand: Ref = {};

  /** The hand that has hold of the pouch, while it has hold of it. */
  let drawing: ControllerHandle | undefined;

  const pickHands = () => {
    const fork =
      hands.find((hand) => hand.inputSource.get()?.handedness === props.forkHand) ?? hands[0];
    const draw = hands.find((hand) => hand !== fork);
    return { fork, draw };
  };

  const update = makeNonReactive((group: THREE.Object3D) => {
    const { fork, draw } = pickHands();
    if (!fork) {
      return;
    }
    fork.controller.updateWorldMatrix(true, false);
    // The whole slingshot rides on the fork hand. Written as a world matrix
    // rather than by parenting, so the frame stays life size however the board
    // it hangs off is scaled.
    setWorldMatrix(group, fork.controller.matrixWorld);

    const toWorld = fork.controller.matrixWorld;
    const toLocal = toWorld.clone().invert();
    const forkWorld = POUCH_REST.clone().applyMatrix4(toWorld);

    const origin = worldOrigin(ctx);
    origin?.updateWorldMatrix(true, false);
    const toBoard = origin ? origin.matrixWorld.clone().invert() : new THREE.Matrix4();
    const fromBoard = origin ? origin.matrixWorld.clone() : new THREE.Matrix4();

    const forkBoard = forkWorld.clone().applyMatrix4(toBoard);
    const handBoard = draw ? handPosition(draw).applyMatrix4(toBoard) : forkBoard.clone();

    if (drawing) {
      if (!triggerPressed(drawing)) {
        const pouchBoard = clampDraw(forkBoard, handBoard, defaultLaunchOptions.maxDraw);
        const launch = computeLaunch(forkBoard, pouchBoard, defaultLaunchOptions);
        if (launch) {
          emit(props, "shoot", { position: launch.position, velocity: launch.velocity });
          pulse(drawing, 0.8, 60);
          pulse(fork, 0.5, 40);
        }
        drawing = undefined;
      }
    } else if (draw && triggerPressed(draw) && handBoard.distanceTo(forkBoard) < CAPTURE_RADIUS) {
      drawing = draw;
      pulse(draw, 0.3, 30);
    }

    const pouchBoard = drawing
      ? clampDraw(forkBoard, handBoard, defaultLaunchOptions.maxDraw)
      : forkBoard;
    const pouchLocal = pouchBoard.clone().applyMatrix4(fromBoard).applyMatrix4(toLocal);

    pouch.current?.position.copy(pouchLocal);
    if (leftBand.current) {
      setSegment(leftBand.current, TIP_LEFT, pouchLocal);
    }
    if (rightBand.current) {
      setSegment(rightBand.current, TIP_RIGHT, pouchLocal);
    }
  });

  /** A fixed part of the frame: cut once, never moved again. */
  const strut = (from: THREE.Vector3, to: THREE.Vector3, radius: number, colour: string) =>
    $(new THREE.Mesh(), [
      effects((o) => {
        setSegment(o, from, to);
        o.geometry = cylinderGeometry(radius, 1, 8);
        o.material = basicMaterial(colour);
      }),
    ]);

  const band = (ref: Ref) =>
    $(new THREE.Mesh(), [
      effects((o) => {
        ref.current = o;
        o.geometry = cylinderGeometry(BAND_RADIUS, 1, 6);
        o.material = basicMaterial(BAND_COLOUR);
        setSegment(o, TIP_LEFT, POUCH_REST);
      }),
    ]);

  return $(new THREE.Group(), [
    effects((group) => {
      group.matrixAutoUpdate = true;
      use(
        animate(ctx, () => {
          update(group);
        }),
      );
    }),
    children(
      strut(HANDLE_BOTTOM, YOKE, FRAME_RADIUS, FRAME_COLOUR),
      strut(YOKE, TIP_LEFT, FRAME_RADIUS, FRAME_COLOUR),
      strut(YOKE, TIP_RIGHT, FRAME_RADIUS, FRAME_COLOUR),
      band(leftBand),
      band(rightBand),
      $(new THREE.Mesh(), [
        effects((o) => {
          pouch.current = o;
          o.position.copy(POUCH_REST);
          o.geometry = sphereGeometry(STONE_RADIUS, 16, 12);
          o.material = stoneMaterial("#3f3a37");
        }),
      ]),
    ),
  ]);
});

export default Slingshot;
