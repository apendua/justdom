import * as THREE from "three";
import { children, cursors, $, dom, getScene, getXRSession, placeAndScale } from "@apendua/freedom";
import type { PortalOptions } from "@apendua/freedom";
import { createDiagnostics, useDiagnostics } from "@apendua/justui";
import { component, effects, effectsOnly, Stream, useEffects } from "@apendua/signal";
import { xrSession } from "../session.js";

/** The height of the desk's top, below the eyes, in metres. */
const DESK_TOP = -0.42;

/**
 * How big a desk px is in the room: 0.65 mm, which makes the monitor 40 cm
 * across and the keyboard 43 cm, about what the real things were. A portal
 * draws a px a centimetre, so a panel is scaled by this over 0.01.
 */
const PX = 0.00065;

/** The colours of the page's wall and desk, so the room is the same room. */
const WALL = "#1b3331";
const WOOD = "#8a5a33";
const BACKDROP = "#0f1716";

/**
 * Where one object of the page stands in the room. `x`, `y` and `z` are
 * the middle of the panel; `y` is measured up from the desk's top. `facing`
 * turns it about the vertical to face the viewer from where it stands, and
 * `lying` lays it down on the desk, tipped up toward the viewer by `tilt`.
 */
interface Placement {
  id: string;
  x: number;
  y: number;
  z: number;
  facing?: boolean;
  lying?: boolean;
  tilt?: number;
  /** A turn about the panel's own normal, for something lying askew. */
  roll?: number;
  /** Metres per desk px, if not `PX`. */
  px?: number;
  options?: Omit<PortalOptions, "root">;
}

const degrees = (value: number) => (value * Math.PI) / 180;

/**
 * The objects that are mirrored, and where. The page's backdrop, its wall
 * and its tabletop are not among them: the room has a wall and a desk of
 * its own, and what stands on the desk is the page's.
 */
export const PLACEMENTS: readonly Placement[] = [
  // The monitor stands on the desk, its foot on the top.
  { id: "monitor", x: 0, y: 0.168, z: -0.78 },
  // The keyboard lies in front of it, raised at the back as keyboards are.
  { id: "keyboard", x: 0, y: 0.014, z: -0.47, lying: true, tilt: degrees(9) },
  // The charts and the board stand either side, turned in toward the chair.
  // They are read rather than used, so they are drawn bigger than the
  // monitor's px, about the size of a poster each.
  {
    id: "charts",
    x: -0.58,
    y: 0.3,
    z: -0.62,
    px: 0.00095,
    facing: true,
    options: { draggable: true },
  },
  {
    id: "board",
    x: 0.58,
    y: 0.25,
    z: -0.62,
    px: 0.00095,
    facing: true,
    options: { draggable: true },
  },
  // The floppies lie to the left of the keyboard; between them is the
  // desk, which a ray should reach.
  {
    id: "floppies",
    x: -0.4,
    y: 0.002,
    z: -0.44,
    lying: true,
    options: { opaqueToRays: false, loadingFrame: false },
  },
  // The memo lies askew to the right, and can be picked up and tipped to
  // read: `level: false` hands it the hand's whole rotation.
  {
    id: "memo",
    x: 0.37,
    y: 0.003,
    z: -0.44,
    lying: true,
    roll: degrees(6),
    options: { draggable: { level: false } },
  },
  // The clock hangs on the wall above the monitor, bigger than on the
  // page, where it is a long way off.
  {
    id: "clock",
    x: 0,
    y: 0.68,
    z: -1.19,
    px: 0.0015,
    options: { opaqueToRays: false, loadingFrame: false },
  },
];

/**
 * A source that says nothing and never finishes: what a mounting is handed
 * while there is nothing to mount.
 */
const NOTHING = new Stream<never>(() => {});

/**
 * The room the desk is set in: a wall behind, a desk on legs, a floor, and
 * a sky in one dark colour all the way round, which is what an AR session
 * clears to rather than the passthrough.
 */
function room(): THREE.Object3D {
  const group = new THREE.Group();
  const matte = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 });

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    new THREE.MeshBasicMaterial({ color: BACKDROP, side: THREE.BackSide, depthWrite: false }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;

  const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.03, 0.85), matte(WOOD));
  top.position.set(0, DESK_TOP - 0.015, -0.6);
  const legs = [-0.8, 0.8].flatMap((x) =>
    [-0.22, -0.98].map((z) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, 0.05), matte("#5e3a1e"));
      leg.position.set(x, DESK_TOP - 0.38, z);
      return leg;
    }),
  );
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), matte(WALL));
  wall.position.set(0, 0.4, -1.2);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), matte("#141c1b"));
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
 * Nothing here builds UI. Each element named in `PLACEMENTS` is one the page
 * is showing; `dom(ctx, element)` mirrors it where it stands, so a press on
 * a mirrored key is a click on the real one and a card dragged in the room
 * is dragged on the page. The panels exist only while a session presents:
 * a session that starts builds them from the page as it is then, and one
 * that ends takes them down. `xrSession` tells the page first, so that it
 * takes its staging off before anything is measured.
 */
export const Scene = (elements: ReadonlyMap<string, HTMLElement>) =>
  effectsOnly((ctx: WeakKey) => {
    // Kept across sessions, so a second session's chart starts from the
    // first one's scale.
    const diagnostics = createDiagnostics();

    useEffects(getScene(ctx), [
      effects((scene) => {
        // For a VR session, where three honours it; the sky in `room` is
        // for AR, where it does not.
        scene.background = new THREE.Color(BACKDROP);
      }),
      effects(() => {
        const session = getXRSession(ctx);
        xrSession.set(session);
        if (session) {
          useDiagnostics(ctx, diagnostics);
        }
      }),
      children(
        $(room()),
        $(mug()),
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
          return $(new THREE.Group(), [
            children(
              ...PLACEMENTS.flatMap((placement) => {
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
