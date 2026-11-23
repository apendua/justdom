import * as THREE from "three";
import { $, children, cursors, dom, getScene, getXRSession } from "justdom-three";
import { createDiagnostics, useDiagnostics } from "justdom-three-ui";
import { effects, effectsOnly, useEffects } from "justdom-signal";
import { enterSession } from "justdom-xr/session";
import { Backdrop, clientRect, whilePresenting } from "justdom-xr/scene";
import { NIGHT } from "./theme";
import { SESSION_LAYOUT_WIDTH, TABLE_AT, tableScale } from "../placement";
import type { TableState } from "../store/TableState";
import { Atom } from "./Atom";

/**
 * The scene: the page's own table, mirrored into one panel in front of the
 * viewer, and beside it the atom of the element the table shows.
 *
 * Nothing here builds the table. The element handed in is the one the page
 * mounted it into and is showing right now; `dom(ctx, element)` watches it
 * where it stands, so a ray on a tile is the pointer on the real tile, and
 * the popup and the inspector the page draws for it are drawn in the panel.
 * The atom reads the same state the page writes, so it follows the ray
 * from tile to tile.
 *
 * Both exist only while a session is presenting. Between sessions the page
 * is all anyone sees.
 */
export const Scene = (table: HTMLElement, state: TableState) =>
  effectsOnly((ctx: WeakKey) => {
    // Kept across sessions, so a second session's chart starts from the
    // first one's scale rather than from nothing.
    const diagnostics = createDiagnostics();
    // Built once, and mounted in each session.
    const atom = Atom(state);

    useEffects(getScene(ctx), [
      effects((scene) => {
        // For a VR session, where three honours it; the backdrop is for AR,
        // where it does not.
        scene.background = new THREE.Color(NIGHT);
      }),
      effects(() => {
        // Re-run as a session starts and as it ends, for the header's ×
        // and passthrough switch, and for the backdrop. Before the panel
        // below is built, so that the header it measures already shows them.
        const session = getXRSession(ctx);
        enterSession(session);
        // Laid out wide for the panel, whatever the window: the page is
        // under the session's canvas until it ends.
        table.style.width = session ? `${SESSION_LAYOUT_WIDTH}px` : "";
        if (session) {
          useDiagnostics(ctx, diagnostics);
        }
      }),
      children(
        Backdrop(NIGHT),
        $(new THREE.PointLight(0xffffff, 60, 6), [
          effects((o) => {
            o.position.set(-0.6, 1.2, 0.5);
          }),
        ]),
        $(new THREE.AmbientLight(0xffffff, 1.6)),
        whilePresenting(ctx, () =>
          dom(ctx, table, [
            effects((o) => {
              // Measured again whenever the card is resized, as it is when
              // the window is, so the table stays as wide.
              o.scale.setScalar(tableScale(clientRect(table).width));
              o.position.set(...TABLE_AT);
            }),
          ]),
        ),
        whilePresenting(ctx, () => atom(ctx)),
        cursors(ctx, { color: "#5cc8ff" }),
      ),
    ]);
  });

export default Scene;
