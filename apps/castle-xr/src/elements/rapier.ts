/**
 * Rapier bindings, the same shape as the ones in marblerun: a world held in a
 * context, rigid bodies attached to scene objects through an operator, and a
 * fixed step loop driven off the render loop.
 *
 * One thing differs, and it matters for a game about knocking things down: the
 * ground is placed so that its *surface* is the origin's y = 0. A brick resting
 * on the ground therefore has its centre exactly half its own height up, which
 * is the same arithmetic the half grid uses, so a brick placed on the floor of
 * the board is already sitting on the floor of the simulation.
 */
import { createProperty, onCleanup } from "@apendua/signal";
import * as THREE from "three";
import * as RAPIER from "@dimforge/rapier3d";
import { MonoTypeOperatorFunction, Observable } from "rxjs";
import { effects, observable, use, useEffects } from "@apendua/signal";
import { animate, layoutEffects, setWorldMatrix } from "@apendua/freedom";

export interface RapierWorkspace {
  world: RAPIER.World;
}

/** Half the thickness of the slab that stands in for the ground. */
const GROUND_HALF_THICKNESS = 5;

/**
 * The simulation runs in board units, and a board unit is ten centimetres of
 * room (see the scale in `App.ts`), so a metre-per-second-squared is ten
 * units-per-second-squared here.
 */
const BOARD_UNITS_PER_METRE = 10;

/**
 * Earth's own, in board units. Handing Rapier the familiar 9.81 would really
 * be handing it a tenth of that, and the castle would come down in the gentle
 * slow motion of things falling on a world one tenth the gravity — everything
 * in the simulation is a tenth of its apparent size, so it has ten times as
 * far to fall, in board units, as the raw number suggests.
 */
const GRAVITY = -9.81 * BOARD_UNITS_PER_METRE;

export function createRapierContext(): RapierWorkspace {
  const gravity = new RAPIER.Vector3(0, GRAVITY, 0);
  const world = new RAPIER.World(gravity);

  const ground = RAPIER.ColliderDesc.cuboid(200, GROUND_HALF_THICKNESS, 200)
    .setTranslation(0, -GROUND_HALF_THICKNESS, 0)
    .setFriction(0.9);
  world.createCollider(ground);

  return {
    world,
  };
}

export const RapierContext = createProperty<RapierWorkspace>(createRapierContext);

const origins = new WeakMap<RAPIER.World, THREE.Object3D>();

/**
 * Marks the object whose coordinate system the simulation runs in. Bodies are
 * built from, and written back to, poses relative to it, so the whole board can
 * be moved and scaled in the room without the physics noticing.
 */
export function useAsWorldOrigin(ctx: WeakKey): MonoTypeOperatorFunction<THREE.Object3D> {
  const { world } = RapierContext.get(ctx);
  return effects((o) => {
    origins.set(world, o);
    onCleanup(() => {
      if (origins.get(world) === o) {
        origins.delete(world);
      }
    });
  });
}

/** The object the simulation's coordinates are expressed in, if there is one. */
export function worldOrigin(ctx: WeakKey): THREE.Object3D | undefined {
  const { world } = RapierContext.get(ctx);
  return origins.get(world);
}

/**
 * Attaches a collider described on the fly. The description is read inside an
 * effect, so a collider that depends on reactive props is rebuilt when they
 * change.
 */
export function collider(
  ctx: WeakKey,
  describe: () => RAPIER.ColliderDesc | null,
  onCreated?: (collider: RAPIER.Collider) => void,
): MonoTypeOperatorFunction<RAPIER.RigidBody> {
  const { world } = RapierContext.get(ctx);
  return effects((body) => {
    const desc = describe();
    if (!desc) {
      return;
    }
    const created = world.createCollider(desc, body);
    onCreated?.(created);
    onCleanup(() => {
      world.removeCollider(created, false);
    });
  });
}

export function rigidBody<T extends THREE.Object3D>(
  ctx: WeakKey,
  type: RAPIER.RigidBodyType,
  operators: MonoTypeOperatorFunction<RAPIER.RigidBody>[],
): MonoTypeOperatorFunction<T> {
  const { world } = RapierContext.get(ctx);
  return layoutEffects((obj) => {
    const origin = origins.get(world) ?? new THREE.Object3D();

    obj.updateWorldMatrix(true, false);
    origin.updateWorldMatrix(true, false);

    const originOffset = origin.matrixWorld.clone().invert().multiply(obj.matrixWorld);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    originOffset.decompose(position, quaternion, scale);

    const body = world.createRigidBody(new RAPIER.RigidBodyDesc(type));
    body.setTranslation(new RAPIER.Vector3(position.x, position.y, position.z), false);
    body.setRotation(
      new RAPIER.Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w),
      false,
    );

    useEffects(body, operators);
    use(
      animate(ctx, () => {
        const translation = body.translation();
        const rotation = body.rotation();
        const newOriginOffset = new THREE.Matrix4().compose(
          new THREE.Vector3(translation.x, translation.y, translation.z),
          new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
          scale,
        );
        origin.updateWorldMatrix(true, false);
        setWorldMatrix(obj, origin.matrixWorld.clone().multiply(newOriginOffset));
      }),
    );
    onCleanup(() => {
      world.removeRigidBody(body);
    });
  });
}

export function runSimulation(
  ctx: WeakKey,
  fps: number = 60,
  onAfterStep?: () => void,
): Observable<void> {
  const { world } = RapierContext.get(ctx);
  return observable(() => {
    let lastTime = performance.now();
    let accumulator = 0;
    const fixedTimeStep = 1 / fps;
    // A frame that arrives after a long stall must not be paid back all at
    // once, or a castle spends its first frame after the phase change being
    // shoved through the floor.
    const maxCatchUp = fixedTimeStep * 5;
    use(
      animate(ctx, () => {
        const currentTime = performance.now();
        const deltaTime = (currentTime - lastTime) / 1000;
        lastTime = currentTime;

        accumulator = Math.min(accumulator + deltaTime, maxCatchUp);
        while (accumulator >= fixedTimeStep) {
          world.step();
          accumulator -= fixedTimeStep;
        }
        onAfterStep?.();
      }),
    );
  });
}
