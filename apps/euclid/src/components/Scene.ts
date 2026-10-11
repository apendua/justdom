import * as THREE from "three";
import { $, children, cursors, dom, getScene, getXRSession } from "@apendua/freedom";
import type { PortalOptions } from "@apendua/freedom";
import { createDiagnostics, useDiagnostics } from "@apendua/justui";
import { component, effects, effectsOnly, Stream, useEffects } from "@apendua/signal";
import { enterSession } from "@apendua.dev/headset/session";
import { Backdrop, clientRect } from "@apendua.dev/headset/scene";
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

/** The three elements the app is mounted in, each a panel in a session. */
export interface Mounts {
  toolbar: HTMLElement;
  editor: HTMLElement;
  canvas: HTMLElement;
}

/**
 * One of the page's mount points, mirrored into a panel at `at`, turned to
 * face the head and scaled by `scale`, which is asked for from the size the
 * page laid the element out at, as the session starts and again whenever
 * the element is resized, as it is when the window is. There only while a
 * session is presenting.
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
    const { pitch, yaw } = facing(at);
    return dom(
      ctx,
      element,
      [
        effects((o) => {
          o.scale.setScalar(scale(clientRect(element)));
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
        Backdrop(BACKDROP),
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
        // (`MAX_COMMIT_WAIT`). A move whose reading fits the frame's budget
        // lands that frame either way; one whose reading overruns it would
        // land once a second rather than follow the hand. A torn frame of a
        // drawing in motion is the lesser harm.
        //
        // And first in the frame's budget, which the three panels share: a
        // drag rewrites a statement on every move, so the program has work
        // to bring in exactly when the drawing does, and the drawing is
        // what follows the hand. The program catches up once the hand
        // stops.
        Panel(ctx, canvas, BOARD_AT, (rect) => boardScale(rect.width, rect.height), {
          atomic: false,
          priority: 1,
        }),
        // The mark at the end of each ray. Half the default size: a drawn
        // point is a few millimetres across, and the mark aiming at one
        // should not hide it.
        cursors(ctx, { color: "#3b82f6", scale: 0.5 }),
      ),
    ]);
  });

export default Scene;
