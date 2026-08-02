/**
 * The board: building the castle, and then knocking it down.
 *
 * Building follows marblerun — a tray of bricks, a drag that shows the brick
 * itself at the pose it would land in, the thumbstick for the turns a wrist
 * cannot comfortably reach — with the port snapping replaced by the half grid,
 * because a castle is stacked rather than plugged together.
 *
 * The siege is the same board with the bricks handed over to Rapier: they stop
 * being fixed scenery and become dynamic bodies, and a slingshot appears in the
 * player's hands. The game is won when every brick is lying on the ground.
 */
import * as THREE from "three";
import { animate, camera, children, keyedList, Nothing, session, $ } from "@apendua.dev/three";
import { switchMap } from "rxjs";
import {
  batch,
  component,
  effects,
  makeNonReactive,
  observeFn,
  on,
  ReactiveMap,
  set,
  store,
  use,
} from "@apendua.dev/signal";
import * as RAPIER from "@dimforge/rapier3d";
import Grid from "./Grid.js";
import Brick from "./Brick.js";
import Palette from "./Palette.js";
import Projectile from "./Projectile.js";
import Slingshot from "./Slingshot.js";
import { brickShape, BrickType } from "./types.js";
import { CastleContext, SessionContext } from "../elements/context.js";
import { runSimulation, useAsWorldOrigin } from "../elements/rapier.js";
import {
  align,
  alignUpright,
  QUARTER_TURN,
  snapToHorizontalAxis,
  turn,
  upAxis,
} from "../utils/rotations.js";
import { neutralLatch, readStick, StickLatch, stepStick } from "../utils/thumbstick.js";
import { boxesOverlap, brickBox, lowestPoint, rotatedSize, snapToGrid } from "../utils/grid.js";
import { BrickState } from "../store/CastleStore.js";

interface ProjectileState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  firedAt: number;
}

/** Bricks dropped outside this are thrown away rather than placed. */
const BOARD = new THREE.Box3(new THREE.Vector3(-6.5, -0.5, -6.5), new THREE.Vector3(6.5, 14, 6.5));

const PHYSICS_FPS = 60;
/** How near the floor a brick has to be before it counts as fallen. */
const GROUND_TOLERANCE = 0.2;
/** Below this the castle is settled enough for the rubble to be counted. */
const STILL_SPEED = 0.35;
/** Bricks are counted this often, in frames. Every frame would be wasteful. */
const COUNT_EVERY = 12;
const PROJECTILE_LIFETIME = 12_000;
const PROJECTILE_RADIUS = 0.25;

type Ref<T> = { current?: T };

function createRef<T>(value?: T): Ref<T> {
  return store({ current: value });
}

/**
 * Extra rotation the player dialled in with the thumbstick during the current
 * drag, applied on top of the orientation the brick is held at, so the hand
 * only has to get the brick roughly right.
 */
interface Placement {
  offset: THREE.Quaternion;
  latch: StickLatch;
}

/** Where the brick in the hand sits, before it is snapped to anything. */
function heldPose(object: Ref<THREE.Object3D>, matrixWorld: THREE.Matrix4) {
  if (!object.current) {
    return null;
  }
  const matrix = new THREE.Matrix4()
    .copy(matrixWorld)
    .premultiply(object.current.matrixWorld.clone().invert());
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion };
}

const Game = component((ctx: WeakKey) => {
  const castle = CastleContext.get(ctx);
  const gameSession = SessionContext.get(ctx);

  const object = createRef<THREE.Object3D>();
  const preview = store<{
    type?: BrickType;
    position: THREE.Vector3;
    rotation: THREE.Euler;
    blocked: boolean;
  }>({
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    blocked: false,
  });

  const projectiles = new ReactiveMap<string, ProjectileState>();
  const bodies = new Map<string, RAPIER.RigidBody>();

  let view: THREE.Camera | undefined;
  let projectileCounter = 0;
  let frame = 0;

  const placement: Placement = {
    offset: new THREE.Quaternion(),
    latch: neutralLatch,
  };

  const beginPlacement = () => {
    placement.offset.identity();
    placement.latch = neutralLatch;
  };

  /**
   * The board axis pointing to the player's right, which is what pushing the
   * thumbstick forward tumbles the brick around.
   */
  const tumbleAxis = () => {
    if (!view || !object.current) {
      return new THREE.Vector3(1, 0, 0);
    }
    const right = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(view.getWorldQuaternion(new THREE.Quaternion()))
      .applyQuaternion(object.current.getWorldQuaternion(new THREE.Quaternion()).invert());
    right.y = 0;
    return snapToHorizontalAxis(right);
  };

  /** Whether a brick placed here would share space with one already built. */
  const isBlocked = makeNonReactive(
    (position: THREE.Vector3, extent: THREE.Vector3, exclude?: BrickState) => {
      const box = brickBox(position, extent);
      for (const brick of castle.bricks.values()) {
        if (brick === exclude) {
          continue;
        }
        const other = brickBox(
          brick.position,
          rotatedSize(
            brickShape(brick.type).size,
            new THREE.Quaternion().setFromEuler(brick.rotation),
          ),
        );
        if (boxesOverlap(box, other)) {
          return true;
        }
      }
      return false;
    },
  );

  /**
   * Work out where the brick being dragged would land, and show it there. The
   * brick is snapped to the half grid by its corner rather than its centre, so
   * its faces line up with everything already built; a brick that would end up
   * inside another one, or under the floor, is shown as refused.
   */
  const updatePreview = makeNonReactive(
    (
      event: { matrixWorld: THREE.Matrix4; inputSource?: XRInputSource },
      type: BrickType,
      exclude?: BrickState,
    ) => {
      const held = heldPose(object, event.matrixWorld);
      if (!held) {
        return;
      }
      const steps = event.inputSource
        ? stepStick(placement.latch, readStick(event.inputSource.gamepad))
        : { latch: placement.latch, x: 0 as const, y: 0 as const };
      placement.latch = steps.latch;

      if (steps.x) {
        // Pushing the stick right turns the brick clockwise seen from above.
        placement.offset.copy(turn(placement.offset, upAxis, -steps.x * QUARTER_TURN));
      }
      if (steps.y) {
        // Pushing the stick forward tips the top of the brick away from the player.
        placement.offset.copy(turn(placement.offset, tumbleAxis(), steps.y * QUARTER_TURN));
      }

      const quaternion = align(
        new THREE.Quaternion().copy(placement.offset).multiply(alignUpright(held.quaternion)),
      );
      const extent = rotatedSize(brickShape(type).size, quaternion);
      const position = snapToGrid(held.position, extent);

      batch(() => {
        preview.type = type;
        preview.position = position;
        preview.rotation = new THREE.Euler().setFromQuaternion(quaternion);
        preview.blocked = isBlocked(position, extent, exclude);
      });
    },
  );

  /** Where a released brick belongs, or null if it may not go there. */
  const dropPose = makeNonReactive(() => {
    if (!preview.type || preview.blocked) {
      return null;
    }
    if (!BOARD.containsPoint(preview.position)) {
      return null;
    }
    return { position: preview.position.clone(), rotation: preview.rotation.clone() };
  });

  /**
   * The face buttons on either controller walk the history: the near one takes
   * a change back, the far one puts it in again.
   */
  const pressed = new WeakMap<XRInputSource, boolean[]>();
  const UNDO_BUTTON = 4;
  const REDO_BUTTON = 5;

  const pollButtons = makeNonReactive((xrSession: XRSession) => {
    for (const source of xrSession.inputSources) {
      const buttons = source.gamepad?.buttons;
      if (!buttons) {
        continue;
      }
      const before = pressed.get(source) ?? [];
      const now = buttons.map((button) => button.pressed);
      if (gameSession.phase.get() === "build") {
        if (now[UNDO_BUTTON] && !before[UNDO_BUTTON]) {
          castle.history.undo();
        }
        if (now[REDO_BUTTON] && !before[REDO_BUTTON]) {
          castle.history.redo();
        }
      }
      pressed.set(source, now);
    }
  });

  const fire = makeNonReactive((shot: { position: THREE.Vector3; velocity: THREE.Vector3 }) => {
    projectiles.set(
      `stone-${projectileCounter++}`,
      store<ProjectileState>({
        position: shot.position.clone(),
        velocity: shot.velocity.clone(),
        firedAt: performance.now(),
      }),
    );
    gameSession.shots.setFn((count) => count + 1);
  });

  /**
   * Counts what is still standing. A brick is down once it is touching the
   * ground, whatever way up it ended; the castle is beaten when every brick is
   * down and the rubble has stopped moving.
   */
  const countStanding = makeNonReactive(() => {
    let standing = 0;
    let moving = false;
    let total = 0;
    for (const [id, body] of bodies) {
      const brick = castle.bricks.get(id);
      if (!brick) {
        continue;
      }
      total += 1;
      const translation = body.translation();
      const rotation = body.rotation();
      const extent = rotatedSize(
        brickShape(brick.type).size,
        new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
      );
      if (lowestPoint(translation.y, extent.y) > GROUND_TOLERANCE) {
        standing += 1;
      }
      const velocity = body.linvel();
      if (
        velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z >
        STILL_SPEED * STILL_SPEED
      ) {
        moving = true;
      }
    }
    gameSession.standing.set(standing);
    gameSession.total.set(total);
    if (total > 0 && standing === 0 && !moving) {
      gameSession.won.set(true);
    }
  });

  const cullProjectiles = makeNonReactive(() => {
    const now = performance.now();
    for (const [id, projectile] of projectiles.entries()) {
      if (now - projectile.firedAt > PROJECTILE_LIFETIME) {
        projectiles.delete(id);
      }
    }
  });

  // The simulation only runs during the siege; while the castle is being built
  // the bricks have no bodies at all, so nothing can nudge them.
  use(() => {
    if (gameSession.phase.get() !== "siege") {
      projectiles.clear();
      return;
    }
    return runSimulation(ctx, PHYSICS_FPS, () => {
      frame += 1;
      if (frame % COUNT_EVERY === 0) {
        countStanding();
        cullProjectiles();
      }
    });
  });

  return $(new THREE.Group(), [
    useAsWorldOrigin(ctx),
    effects((o) => {
      object.current = o;
    }),
    effects(() => {
      use(
        camera(ctx).pipe(
          effects((value) => {
            view = value;
          }),
        ),
      );
    }),
    effects(() => {
      use(
        session(ctx).pipe(
          switchMap((current) => current),
          switchMap((xrSession) =>
            animate(ctx, () => {
              pollButtons(xrSession);
            }),
          ),
        ),
      );
    }),
    children(
      Grid(ctx, [set({ size: 24, cellWidth: 0.5 })]),
      component(() => {
        if (gameSession.phase.get() !== "build") {
          return Nothing();
        }
        return Palette(ctx, [
          set({
            // Parked to the right of the board, tipped up towards the player.
            position: new THREE.Vector3(9, 0.4, 2),
            rotation: new THREE.Euler(0.3, -Math.PI / 8, 0),
          }),
          on("dragstart", () => {
            beginPlacement();
          }),
          on("dragmove", (event) => {
            updatePreview(event, event.brickType);
          }),
          on("dragend", (event) => {
            const drop = dropPose();
            delete preview.type;
            if (!drop) {
              return;
            }
            castle.place({ type: event.brickType, ...drop });
          }),
        ]);
      })(),
      component(() => {
        const type = preview.type;
        if (!type) {
          return Nothing();
        }
        return Brick(ctx, [
          set({
            type,
            get style() {
              return preview.blocked ? "blocked" : "ghost";
            },
            interactive: false,
            bodyType: null,
            get position() {
              return preview.position;
            },
            get rotation() {
              return preview.rotation;
            },
          }),
        ]);
      })(),
      keyedList(
        observeFn(castle.bricks).entries(),
        component((brick: BrickState, brickId: string) => {
          return Brick(ctx, [
            set({
              get type() {
                return brick.type;
              },
              get draggable() {
                return gameSession.phase.get() === "build";
              },
              get bodyType() {
                return gameSession.phase.get() === "siege" ? RAPIER.RigidBodyType.Dynamic : null;
              },
              get position() {
                return brick.position;
              },
              get rotation() {
                return brick.rotation;
              },
            }),
            on("bodycreated", ({ body }) => {
              bodies.set(brickId, body);
            }),
            on("bodyremoved", () => {
              bodies.delete(brickId);
            }),
            on("dragstart", () => {
              beginPlacement();
            }),
            on("dragmove", (event) => {
              // A brick being moved must not be counted as blocking itself.
              updatePreview(event, brick.type, brick);
            }),
            on("dragend", (event) => {
              const drop = dropPose();
              const outside = Boolean(preview.type && !BOARD.containsPoint(preview.position));
              delete preview.type;
              if (event.clone) {
                // The brick that was gripped stays where it was; only the copy
                // that came off it is placed.
                event.reset();
                if (drop) {
                  castle.place({ type: brick.type, ...drop });
                }
                return;
              }
              if (outside) {
                castle.remove(brickId);
                return;
              }
              if (drop) {
                castle.move(brickId, drop.position, drop.rotation);
              }
            }),
          ]);
        }),
      ),
      keyedList(
        observeFn(projectiles).entries(),
        component((projectile: ProjectileState) => {
          return Projectile(ctx, [
            set({
              radius: PROJECTILE_RADIUS,
              get position() {
                return projectile.position;
              },
              get velocity() {
                return projectile.velocity;
              },
            }),
          ]);
        }),
      ),
      component(() => {
        if (gameSession.phase.get() !== "siege") {
          return Nothing();
        }
        return Slingshot(ctx, [
          set({
            get forkHand() {
              return gameSession.forkHand.get();
            },
          }),
          on("shoot", (shot) => {
            fire(shot);
          }),
        ]);
      })(),
    ),
  ]);
});

export default Game;
