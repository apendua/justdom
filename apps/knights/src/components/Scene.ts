import * as THREE from "three";
import { $, children, cursors, dom, getScene, getXRSession } from "@apendua/freedom";
import { createDiagnostics, useDiagnostics } from "@apendua/justui";
import { component, effects, effectsOnly, Stream, useEffects } from "@apendua/signal";
import { backdropShown, enterSession } from "@apendua.dev/headset/session";
import { GAME_AT, gameScale } from "../placement";

/**
 * What the session is set against unless the room is asked for: one dark
 * colour, all the way round, so that the battlefield is the brightest
 * thing in view.
 */
const BACKDROP = "#181410";

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
 * The scene: the page's own game, mirrored whole into one panel in front
 * of the viewer, the battlefield over the toolbar as the page has them.
 *
 * Nothing here builds UI. The element handed in is the one the page mounted
 * the game into and is showing right now; `dom(ctx, element)` watches it
 * where it stands, so what the headset shows is what the page shows, the
 * same nodes. The board hears a ray moving over it as `mousemove` and a
 * trigger press as `click`, each at the place on the page the ray met, so
 * the handlers that already serve the mouse preview the route and send the
 * stack along it.
 *
 * The panel is not atomic. The sprites step through their frames ten times
 * a second, and the stack that is moving walks between fields every frame
 * it moves, so a panel that held each change back until a frame found
 * nothing left to resolve would rarely find one. A torn frame of a battle
 * in motion is the lesser harm, as it is for Euclid's drawing.
 *
 * The panel exists only while a session is presenting. Between sessions
 * the page is all anyone sees, and a portal kept up behind it would go on
 * mirroring every hover on the page into a scene nobody is looking at.
 */
export const Scene = (root: HTMLElement) =>
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
        // and passthrough switch, and for the backdrop. Before the panel
        // below is built, so that the toolbar it measures already shows
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
        component(() => {
          if (!getXRSession(ctx)) {
            return NOTHING;
          }
          // Measured once, as the session starts.
          const scale = gameScale(root.getBoundingClientRect().width);
          return dom(
            ctx,
            root,
            [
              effects((o) => {
                o.scale.setScalar(scale);
                o.position.set(...GAME_AT);
              }),
            ],
            { draggable: true, atomic: false },
          );
        })(),
        cursors(ctx, { color: "#ff0000" }),
      ),
    ]);
  });

export default Scene;
