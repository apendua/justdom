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
import {
  component,
  effects,
  emit,
  makeNonReactive,
  onCleanup,
  Op,
  store,
  use,
} from "@apendua.dev/signal";
import {
  $,
  animate,
  camera,
  children,
  controllers,
  setWorldMatrix,
  ControllerHandle,
} from "@apendua.dev/three";
import { cylinderGeometry, sphereGeometry } from "../elements/geometry.js";
import { basicMaterial, stoneMaterial } from "../elements/material.js";
import { clampDraw, computeLaunch, defaultLaunchOptions } from "../utils/launch.js";
import { worldOrigin } from "../elements/rapier.js";
import { palette } from "../elements/palette.js";
import { ForkHand } from "../store/Session.js";

interface Props {
  forkHand: ForkHand;
  /**
   * Hold the slingshot out in front of the head instead of in a hand, aimed
   * where the player is looking. Together with the keyboard draw below, this is
   * what makes the game playable at a desk, where the emulator gives you a head
   * that follows the mouse but hands that have to be dragged about by hand.
   */
  gazeAim: boolean;
}

interface Events {
  /** A stone leaving the pouch, in the board's coordinates. */
  shoot: { position: THREE.Vector3; velocity: THREE.Vector3 };
}

const defaults: Props = {
  forkHand: "left",
  gazeAim: false,
};

/** The trigger, in the xr-standard gamepad mapping. */
const TRIGGER = 0;

/**
 * Drawing the pouch with no hand free to draw it with: hold the key and the
 * pouch is pulled straight back along the fork's own line, reaching a full draw
 * after this long, and let go to fire. The bands stretch exactly as they would
 * under a hand, so what the shot is worth is still there to be seen — and the
 * shot itself goes through the same arithmetic, so nothing about it is special.
 */
const DRAW_KEY = "Space";
const KEY_DRAW_MS = 1200;

/**
 * Where the slingshot is held when it is held by the head rather than a hand:
 * out at arm's length, below the line of sight and off to one side, so it is
 * neither in the way of the castle nor pressed against the near plane.
 */
const GAZE_OFFSET = new THREE.Vector3(0.14, -0.18, -0.45);

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
const FRAME_COLOUR = palette.forkFrame;
const BAND_COLOUR = palette.band;

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
  /** The keyboard draw, while the key is down and for the frame after it. */
  let keyDraw: { startedAt: number; released: boolean } | null = null;
  let view: THREE.Camera | undefined;

  const pickHands = () => {
    const fork =
      hands.find((hand) => hand.inputSource.get()?.handedness === props.forkHand) ?? hands[0];
    const draw = hands.find((hand) => hand !== fork);
    return { fork, draw };
  };

  /**
   * Where the frame is held: in a hand, or out in front of the head.
   *
   * Held by the head, the frame is also pushed away as the draw grows. Looking
   * straight down a slingshot, a pouch pulled a full draw back would end up
   * behind the eye it is being pulled towards; letting the fork go out as the
   * pouch comes in splits that between the two, which is also what a drawn bow
   * looks like from behind — one arm out, one hand at the cheek.
   */
  const holdMatrix = (fork: ControllerHandle | undefined, push: number) => {
    if (props.gazeAim && view) {
      view.updateWorldMatrix(true, false);
      const offset = GAZE_OFFSET.clone();
      offset.z -= push;
      return view.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(offset));
    }
    if (!fork) {
      return null;
    }
    fork.controller.updateWorldMatrix(true, false);
    return fork.controller.matrixWorld.clone();
  };

  /** How far into a keyboard draw we are, from nothing to a full pull. */
  const keyRamp = () =>
    keyDraw ? Math.min((performance.now() - keyDraw.startedAt) / KEY_DRAW_MS, 1) : 0;

  const fire = (fork: ControllerHandle | undefined, from: THREE.Vector3, pouch: THREE.Vector3) => {
    const launch = computeLaunch(from, pouch, defaultLaunchOptions);
    if (!launch) {
      return;
    }
    emit(props, "shoot", { position: launch.position, velocity: launch.velocity });
    pulse(drawing, 0.8, 60);
    pulse(fork, 0.5, 40);
  };

  const update = makeNonReactive((group: THREE.Object3D) => {
    const { fork, draw } = pickHands();

    const origin = worldOrigin(ctx);
    origin?.updateWorldMatrix(true, false);
    const toBoard = origin ? origin.matrixWorld.clone().invert() : new THREE.Matrix4();
    const fromBoard = origin ? origin.matrixWorld.clone() : new THREE.Matrix4();
    // Board units to metres, so a draw measured in cells can be turned into how
    // far the frame moves in the room.
    const metresPerUnit = origin ? origin.matrixWorld.getMaxScaleOnAxis() : 1;

    const toWorld = holdMatrix(
      fork,
      0.5 * keyRamp() * defaultLaunchOptions.maxDraw * metresPerUnit,
    );
    if (!toWorld) {
      return;
    }
    // The whole slingshot rides on whatever is holding it. Written as a world
    // matrix rather than by parenting, so the frame stays life size however the
    // board it hangs off is scaled.
    setWorldMatrix(group, toWorld);

    const toLocal = toWorld.clone().invert();
    const forkWorld = POUCH_REST.clone().applyMatrix4(toWorld);

    const forkBoard = forkWorld.clone().applyMatrix4(toBoard);
    const handBoard = draw ? handPosition(draw).applyMatrix4(toBoard) : forkBoard.clone();

    if (drawing) {
      if (!triggerPressed(drawing)) {
        fire(fork, forkBoard, clampDraw(forkBoard, handBoard, defaultLaunchOptions.maxDraw));
        drawing = undefined;
      }
    } else if (draw && triggerPressed(draw) && handBoard.distanceTo(forkBoard) < CAPTURE_RADIUS) {
      drawing = draw;
      keyDraw = null;
      pulse(draw, 0.3, 30);
    }

    let pouchBoard = forkBoard;
    if (drawing) {
      pouchBoard = clampDraw(forkBoard, handBoard, defaultLaunchOptions.maxDraw);
    } else if (keyDraw) {
      // Straight back along the fork's own line, which is the one direction a
      // keyboard can mean.
      const back = new THREE.Vector3(0, 0, 1)
        .transformDirection(toWorld)
        .transformDirection(toBoard)
        .normalize();
      pouchBoard = forkBoard
        .clone()
        .addScaledVector(back, keyRamp() * defaultLaunchOptions.maxDraw);
      if (keyDraw.released) {
        fire(fork, forkBoard, pouchBoard);
        keyDraw = null;
        pouchBoard = forkBoard;
      }
    }
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

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== DRAW_KEY || event.repeat || drawing || keyDraw) {
      return;
    }
    event.preventDefault();
    keyDraw = { startedAt: performance.now(), released: false };
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code !== DRAW_KEY || !keyDraw) {
      return;
    }
    event.preventDefault();
    // Fired on the next frame, where the pouch's position is already worked out.
    keyDraw.released = true;
  };

  return $(new THREE.Group(), [
    effects(() => {
      use(
        camera(ctx).pipe(
          effects((value) => {
            view = value;
          }),
        ),
      );
    }),
    effects((group) => {
      group.matrixAutoUpdate = true;
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      onCleanup(() => {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
      });
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
          o.material = stoneMaterial(palette.stone);
        }),
      ]),
    ),
  ]);
});

export default Slingshot;
