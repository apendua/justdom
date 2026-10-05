import * as THREE from "three";
import { $, children, cursors, dom, getScene, getXRSession } from "@apendua/freedom";
import type { PortalOptions } from "@apendua/freedom";
import { createDiagnostics, useDiagnostics } from "@apendua/justui";
import { component, effects, effectsOnly, Stream, useEffects } from "@apendua/signal";
import { backdropShown, enterSession } from "@apendua.dev/headset/session";
import type { Mounts } from "../offer";
import {
  BOARD_AT,
  boardScale,
  EDITOR_AT,
  editorScale,
  facing,
  TOOLBAR_AT,
  toolbarScale,
  type Vec3,
} from "../placement";

/**
 * What the session is set against unless the room is asked for: one dark
 * colour, all the way round, so that the paper and the program are the
 * brightest things in view.
 */
const BACKDROP = "#141210";

/**
 * A source that says nothing and never finishes: what a mounting is handed
 * while there is nothing to mount.
 */
const NOTHING = new Stream<never>(() => {});

const backdropMaterial = new THREE.MeshBasicMaterial({
  color: BACKDROP,
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
});
const backdropGeometry = new THREE.SphereGeometry(10, 32, 16);

/**
 * An opaque sky in `BACKDROP`, for the case `scene.background` cannot
 * cover, and taken down by the toolbar's passthrough switch.
 *
 * In an AR session three clears the frame to transparent whatever the
 * scene's background says, so that the passthrough shows. A sphere around
 * the viewer, drawn first and taking no part in the depth test, is a
 * background three has no rule about: everything else in the scene draws
 * over it, and nothing of the room shows through. Inside the camera's far
 * plane, which is 20 m.
 */
const Backdrop = component(() =>
  $(new THREE.Mesh(backdropGeometry, backdropMaterial), [
    effects((o) => {
      o.renderOrder = -1;
      o.frustumCulled = false;
      o.visible = backdropShown();
    }),
  ]),
);

/**
 * One of the page's mount points, mirrored into a panel at `at`, turned to
 * face the head and scaled by `scale`, which is asked for as the session
 * starts, from the size the page laid the element out at. There only while
 * a session is presenting.
 *
 * Every panel can be picked up by its edges and put somewhere else, the
 * player's move added on top of where it is placed here. `options` is laid
 * over that, for a panel that needs more.
 */
const Panel = component(
  (
    ctx: WeakKey,
    element: HTMLElement,
    at: Vec3,
    scale: (rect: DOMRect) => number,
    options: PortalOptions = {},
  ) => {
    if (!getXRSession(ctx)) {
      return NOTHING;
    }
    // Measured once, as the session starts.
    const scalar = scale(element.getBoundingClientRect());
    const { pitch, yaw } = facing(at);
    return dom(
      ctx,
      element,
      [
        effects((o) => {
          o.scale.setScalar(scalar);
          o.position.set(...at);
          o.rotation.set(pitch, yaw, 0, "YXZ");
        }),
      ],
      { draggable: true, ...options },
    );
  },
);

/**
 * The scene: the page's own toolbar, program and drawing, each mirrored
 * into a panel in front of the viewer, the drawing straight ahead, the
 * program to its left and the toolbar over it.
 *
 * Nothing here builds UI. The elements handed in are the ones the page
 * mounted the app into and is showing right now; `dom(ctx, element)`
 * watches each where it stands, so what the headset shows is what the page
 * shows, the same nodes, and a press on the drawing is a press on the real
 * `<svg>`, at the place on the page the ray met, which the drawing's own
 * pointer handlers turn into a point, a line or a pan.
 *
 * The panels exist only while a session is presenting. Between sessions the
 * page is all anyone sees, and a portal kept up behind it would go on
 * mirroring every hover on the page into a scene nobody is looking at.
 */
export const Scene = ({ toolbar, editor, canvas }: Mounts) =>
  effectsOnly((ctx: WeakKey) => {
    // Kept across sessions, so a second session's chart starts from the
    // first one's scale rather than from nothing.
    const diagnostics = createDiagnostics();

    useEffects(getScene(ctx), [
      effects((scene) => {
        // For a VR session, where three honours it; the backdrop is for AR,
        // where it does not.
        scene.background = new THREE.Color(BACKDROP);
      }),
      effects(() => {
        // Re-run as a session starts and as it ends, for the toolbar's ×
        // and passthrough switch, and for the backdrop. Before the panels
        // below are built, so that the toolbar they measure already shows
        // them.
        const session = getXRSession(ctx);
        enterSession(session);
        if (session) {
          useDiagnostics(ctx, diagnostics);
        }
      }),
      children(
        Backdrop(),
        $(new THREE.PointLight(0xffffff, 100, 5), [
          effects((o) => {
            o.position.set(0, 1, 3);
          }),
        ]),
        $(new THREE.AmbientLight(0xffffff, 2)),
        Panel(ctx, toolbar, TOOLBAR_AT, (rect) => toolbarScale(rect.width)),
        Panel(ctx, editor, EDITOR_AT, (rect) => editorScale(rect.width, rect.height)),
        // Not atomic: a drag or a pan changes the drawing on every move, and
        // an atomic panel holds each change back until a frame finds nothing
        // left to resolve, or until it has waited a second
        // (`MAX_COMMIT_WAIT`), so the drawing would land once a second rather
        // than follow the hand. A torn frame of a drawing in motion is the
        // lesser harm.
        Panel(ctx, canvas, BOARD_AT, (rect) => boardScale(rect.width, rect.height), {
          atomic: false,
        }),
        // The mark at the end of each ray. Half the default size: a drawn
        // point is a few millimetres across, and the mark aiming at one
        // should not hide it.
        cursors(ctx, { color: "#3b82f6", scale: 0.5 }),
      ),
    ]);
  });

export default Scene;
