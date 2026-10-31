import * as THREE from "three";
import { $, children, cursors, dom, getScene, getXRSession } from "@apendua/freedom";
import { createDiagnostics, useDiagnostics } from "@apendua/justui";
import { component, effects, effectsOnly, Stream, useEffects } from "@apendua/signal";
import { enterSession } from "@apendua.dev/headset/session";
import { Backdrop, clientRect } from "@apendua.dev/headset/scene";
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
 * The board's panel is the size of its element, the part of the window the
 * menu leaves, and the page fits the board to that, so most of the panel is
 * empty around the hexes: it is made transparent to rays, and
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
        Backdrop(BACKDROP),
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
          return dom(
            ctx,
            board,
            [
              effects((o) => {
                // Measured again whenever the board's element is resized,
                // as it is when the window is, so the board stays as tall.
                const { width, height } = clientRect(board);
                o.scale.setScalar(boardScale(width, height));
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
