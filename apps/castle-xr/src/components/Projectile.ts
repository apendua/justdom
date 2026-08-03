import * as THREE from "three";
import { component, effects, Op, set, store } from "@apendua.dev/signal";
import { $, XREventMap } from "@apendua.dev/three";
import * as RAPIER from "@dimforge/rapier3d";
import { collider, rigidBody } from "../elements/rapier.js";
import { sphereGeometry } from "../elements/geometry.js";
import { stoneMaterial } from "../elements/material.js";
import { palette } from "../elements/palette.js";

interface ProjectileProps {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  radius: number;
}

interface ProjectileEvents {
  bodycreated: { body: RAPIER.RigidBody };
}

const defaults: ProjectileProps = {
  position: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  radius: 0.25,
};

/** Dense enough to go through a wall rather than bounce off it. */
const STONE_DENSITY = 12;

/**
 * A stone in flight. Continuous collision detection is on: at slingshot speeds
 * a stone covers more than its own diameter in a single step, and would
 * otherwise pass clean through a brick without ever touching it.
 */
const Projectile = component((ctx: WeakKey, operators: Op<ProjectileProps, ProjectileEvents>) => {
  const props = store<ProjectileProps, ProjectileEvents>(defaults, operators);
  return $(new THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>(), [
    effects((mesh) => {
      mesh.position.copy(props.position);
    }),
    set({
      get geometry() {
        return sphereGeometry(props.radius);
      },
      get material() {
        return stoneMaterial(palette.stone);
      },
    }),
    rigidBody(ctx, RAPIER.RigidBodyType.Dynamic, [
      collider(ctx, () =>
        RAPIER.ColliderDesc.ball(props.radius)
          .setDensity(STONE_DENSITY)
          .setRestitution(0.15)
          .setFriction(0.5),
      ),
      effects((body) => {
        body.setLinvel(
          new RAPIER.Vector3(props.velocity.x, props.velocity.y, props.velocity.z),
          true,
        );
        body.enableCcd(true);
      }),
    ]),
  ]);
});

export default Projectile;
