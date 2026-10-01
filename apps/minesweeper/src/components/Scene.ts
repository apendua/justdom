import * as THREE from "three";
import { $, children, cursors, dom, getScene, getXRSession } from "@apendua/freedom";
import { createDiagnostics, useDiagnostics } from "@apendua/justui";
import { component, effects, effectsOnly, Stream, useEffects } from "@apendua/signal";
import { backdropShown, enterSession } from "../session";
import { BOARD_AT, boardScale, MENU_AT, MENU_PITCH, MENU_SCALE, MENU_YAW } from "../placement";

/**
 * What the session is set against unless the room is asked for: one dark
 * colour, all the way round, so that the pale tiles and the white menu are
 * the brightest things in view.
 */
const BACKDROP = "#1e2430";

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
 * cover, and taken down by the menu's passthrough switch.
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
 * The scene: the page's own board and menu, each mirrored into a panel in
 * front of the viewer.
 *
 * Nothing here builds UI. The elements handed in are the ones the page
 * mounted the game into and is showing right now; `dom(ctx, element)`
 * watches each where it stands, so what the headset shows is what the page
 * shows, the same nodes, and a press on a mirrored tile is a click on the
 * real `<svg>`, at the place on the page the ray met. The grip is the
 * mouse's other button, so it flags a tile through the board's own
 * `contextmenu` handler.
 *
 * The board's panel is the window's size, since the page fits the board to
 * the window, so most of it is empty: it is made transparent to rays, and
 * only the covered tiles, the one shape with `cursor: pointer`, stop one.
 * The menu is draggable by its edges.
 *
 * The panels exist only while a session is presenting. Between sessions the
 * page is all anyone sees, and a portal kept up behind it would go on
 * mirroring every hover on the page into a scene nobody is looking at.
 */
export const Scene = (board: HTMLElement, menu: HTMLElement) =>
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
        // Re-run as a session starts and as it ends, for the menu's × and
        // passthrough switch, and for the backdrop. Before the panels below
        // are built, so that the menu they measure already shows them.
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
        component(() => {
          if (!getXRSession(ctx)) {
            return NOTHING;
          }
          // Measured once, as the session starts.
          const { width, height } = board.getBoundingClientRect();
          const scale = boardScale(width, height);
          return dom(
            ctx,
            board,
            [
              effects((o) => {
                o.scale.setScalar(scale);
                o.position.set(...BOARD_AT);
              }),
            ],
            { opaqueToRays: false },
          );
        })(),
        component(() => {
          if (!getXRSession(ctx)) {
            return NOTHING;
          }
          return dom(
            ctx,
            menu,
            [
              effects((o) => {
                o.scale.setScalar(MENU_SCALE);
                o.position.set(...MENU_AT);
                o.rotation.set(MENU_PITCH, MENU_YAW, 0, "YXZ");
              }),
            ],
            { draggable: true },
          );
        })(),
        cursors(ctx, { color: "#ff0000" }),
      ),
    ]);
  });

export default Scene;
