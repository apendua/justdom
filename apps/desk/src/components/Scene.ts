import * as THREE from "three";
import { xrSession } from "@apendua.dev/headset/session";
import { children, cursors, $, dom, getScene, getXRSession, placeAndScale } from "@apendua/freedom";
import { createDiagnostics, useDiagnostics } from "@apendua/justui";
import { component, effects, effectsOnly, onCleanup, Stream, useEffects } from "@apendua/signal";
import type { MountedDesk } from "../desk.js";
import { DESK_TOP, PX, type Placement, type Room } from "../looks.js";
import type { Readable } from "../session.js";

/**
 * A source that says nothing and never finishes: what a mounting is handed
 * while there is nothing to mount.
 */
const NOTHING = new Stream<never>(() => {});

/**
 * The room the desk is set in, in the look's colours: a wall behind, a desk
 * on legs, a floor, and a sky in one colour all the way round, which is what
 * an AR session clears to rather than the passthrough.
 */
function room(colors: Room): THREE.Object3D {
  const group = new THREE.Group();
  // Lambert: the wall and the floor fill most of the view, and at this
  // roughness the specular term `MeshStandardMaterial` adds is a faint
  // highlight under the point light.
  const matte = (color: string) => new THREE.MeshLambertMaterial({ color });

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    new THREE.MeshBasicMaterial({
      color: colors.backdrop,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;

  const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.03, 0.85), matte(colors.top));
  top.position.set(0, DESK_TOP - 0.015, -0.6);
  const legMaterial = matte(colors.legs);
  const legs = [-0.8, 0.8].flatMap((x) =>
    [-0.22, -0.98].map((z) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, 0.05), legMaterial);
      leg.position.set(x, DESK_TOP - 0.38, z);
      return leg;
    }),
  );
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), matte(colors.wall));
  wall.position.set(0, 0.4, -1.2);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), matte(colors.floor));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, DESK_TOP - 0.73, -0.6);

  group.add(sky, top, ...legs, wall, floor);
  return group;
}

/**
 * The mug, which on the page is a top view and in the room is a mug: the
 * page's steam rises across a flat panel, and a mug lying on its side
 * would not do.
 */
function mug(): THREE.Object3D {
  const group = new THREE.Group();
  const china = new THREE.MeshStandardMaterial({ color: "#f3efe6", roughness: 0.4 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.038, 0.095, 32, 1, true), china);
  body.material.side = THREE.DoubleSide;
  const base = new THREE.Mesh(new THREE.CircleGeometry(0.038, 32), china);
  base.rotation.x = Math.PI / 2;
  base.position.y = -0.0475;
  const coffee = new THREE.Mesh(
    new THREE.CircleGeometry(0.04, 32),
    new THREE.MeshStandardMaterial({ color: "#3b2414", roughness: 0.2 }),
  );
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.y = 0.03;
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.007, 12, 24, Math.PI), china);
  handle.rotation.z = -Math.PI / 2;
  handle.position.x = 0.042;
  group.add(body, base, coffee, handle);
  group.position.set(0.56, DESK_TOP + 0.0475, -0.33);
  return group;
}

/**
 * Free what the meshes under `root` hold on the GPU. three keeps a
 * geometry's buffers and a material's program until `dispose`, and the room
 * and the mug are built anew for every session, so without this each
 * session left the last one's behind. A material or geometry two meshes
 * share is disposed twice, which three takes as once.
 */
function disposeMeshes(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      for (const material of [object.material].flat()) {
        material.dispose();
      }
    }
  });
}

/**
 * Takes down with its mesh whatever it holds on the GPU (`disposeMeshes`).
 */
const disposedWithIt = effects((object: THREE.Object3D) => {
  onCleanup(() => {
    disposeMeshes(object);
  });
});

/**
 * A group posed where `placement` says, scaled so that its panel is drawn at
 * the placement's px. Posed once: nothing here moves unless a hand moves it,
 * and a hand moves the portal's own group, not this one.
 */
function pose(group: THREE.Group, placement: Placement): void {
  const { x, z } = placement;
  if (placement.lying) {
    group.rotation.set(-Math.PI / 2 + (placement.tilt ?? 0), 0, placement.roll ?? 0, "YXZ");
  } else if (placement.facing) {
    group.rotation.set(0, Math.atan2(-x, -z), 0);
  }
  const scale = (placement.px ?? PX) / 0.01;
  placeAndScale(group, x, DESK_TOP + placement.y, z, scale, scale, scale);
}

/**
 * The scene: the page's desk, object by object, set out on a desk in a
 * room.
 *
 * Nothing here builds UI. Each element the look places is one the page is
 * showing; `dom(ctx, element)` mirrors it where it stands, so a press on a
 * mirrored key is a click on the real one and a card dragged in the room is
 * dragged on the page. The room and the panels exist only while a session
 * presents: a session that starts builds them from the look the page is
 * showing then, and one that ends takes them down. `xrSession` tells the
 * page first, so that it takes its staging off before anything is
 * measured.
 */
export const Scene = (desk: Readable<MountedDesk>) =>
  effectsOnly((ctx: WeakKey) => {
    // Kept across sessions, so a second session's chart starts from the
    // first one's scale.
    const diagnostics = createDiagnostics();

    useEffects(getScene(ctx), [
      effects(() => {
        const session = getXRSession(ctx);
        xrSession.set(session);
        if (session) {
          useDiagnostics(ctx, diagnostics);
        }
      }),
      children(
        $(new THREE.AmbientLight(0xffffff, 1.6)),
        $(new THREE.PointLight(0xfff1d6, 6, 4), [
          effects((light) => {
            light.position.set(0.3, 0.6, -0.2);
          }),
        ]),
        component(() => {
          if (!getXRSession(ctx)) {
            return NOTHING;
          }
          const { look, elements } = desk.get();
          return $(new THREE.Group(), [
            effects(() => {
              // For a VR session, where three honours it; the sky in `room`
              // is for AR, where it does not.
              getScene(ctx).background = new THREE.Color(look.room.backdrop);
            }),
            children(
              $(room(look.room), [disposedWithIt]),
              ...(look.mug ? [$(mug(), [disposedWithIt])] : []),
              ...look.placements.flatMap((placement) => {
                const element = elements.get(placement.id);
                if (!element) {
                  return [];
                }
                return [
                  $(new THREE.Group(), [
                    effects((group) => pose(group, placement)),
                    children(dom(ctx, element, [], placement.options)),
                  ]),
                ];
              }),
            ),
          ]);
        })(),
        cursors(ctx, { color: "#ff5a3c" }),
      ),
    ]);
  });

export default Scene;
