import * as THREE from "three";
import { children, cursors, $, dom, getScene, RendererContext } from "@apendua/freedom";
import {
  component,
  effects,
  effectsOnly,
  onCleanup,
  Signal,
  Stream,
  useEffects,
} from "@apendua/signal";

/**
 * What the session is set against: one colour, all the way round, rather
 * than the passthrough an AR session would otherwise show behind the panel
 * or the black a VR one clears to. Dark enough that the pale card reads as
 * the brightest thing in view, which is where the eye should go.
 */
const BACKDROP = "#1e2430";

/**
 * A source that says nothing and never finishes: what a mounting is handed
 * while there is nothing to mount.
 */
const NOTHING = new Stream<never>(() => {});

/**
 * An opaque sky in `BACKDROP`, for the case `scene.background` cannot cover.
 *
 * In an AR session three clears the frame to transparent whatever the
 * scene's background says, so that the passthrough shows — which is the
 * point of AR and the opposite of a single colour. A sphere around the
 * viewer, drawn first and writing no depth, is a background three has no
 * rule about: everything else in the scene draws over it, and nothing of
 * the room shows through. Inside the camera's far plane, which is 20 m.
 */
function backdrop(): THREE.Mesh {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    new THREE.MeshBasicMaterial({ color: BACKDROP, side: THREE.BackSide, depthWrite: false }),
  );
  sphere.renderOrder = -1;
  sphere.frustumCulled = false;
  return sphere;
}

/**
 * The scene: the page's own todo element, mirrored into a panel in front of
 * the viewer.
 *
 * Nothing here builds UI. The element handed in is the one the page mounted
 * the app into and is showing right now; `dom(ctx, element)` watches it
 * where it stands, so what the headset shows is what the page shows, the
 * same nodes, and a press on the mirrored Add button is a click on the real
 * one. The keyboard its field is typed with is not this panel's but the
 * scene's, handed to `render()` as a panel option in `xr.ts`.
 *
 * The panel exists only while a session is presenting. Between sessions the
 * page is all anyone sees, and a portal kept up behind it would go on
 * mirroring every hover and keystroke on the page into a scene nobody is
 * looking at; the renderer draws nothing then either (`presentingOnly` in
 * `xr.ts`). A session that starts builds the panel from the page as it is at
 * that moment, and one that ends takes it down and leaves the page alone.
 */
export const Scene = (panel: HTMLElement) =>
  effectsOnly((ctx: WeakKey) => {
    // Portal px are a centimetre each; a tenth of that makes the 464px card
    // about 46 cm wide, at half a metre — a tablet held out in front of you.
    const scale = 0.1;

    const renderer = RendererContext.get(ctx) as THREE.WebGLRenderer;
    const presenting = Signal.of(renderer.xr.isPresenting);

    useEffects(getScene(ctx), [
      effects((scene) => {
        // For a VR session, where three honours it; the sphere below is
        // for AR, where it does not.
        scene.background = new THREE.Color(BACKDROP);
      }),
      effects(() => {
        const start = () => presenting.set(true);
        const end = () => presenting.set(false);
        renderer.xr.addEventListener("sessionstart", start);
        renderer.xr.addEventListener("sessionend", end);
        onCleanup(() => {
          renderer.xr.removeEventListener("sessionstart", start);
          renderer.xr.removeEventListener("sessionend", end);
        });
      }),
      children(
        $(backdrop()),
        $(new THREE.PointLight(0xffffff, 100, 5), [
          effects((o) => {
            o.position.set(0, 1, 3);
          }),
        ]),
        $(new THREE.AmbientLight(0xffffff, 2)),
        $(new THREE.Group(), [
          effects((o) => {
            o.scale.set(scale, scale, scale);
            // The XR button asks for a `local` reference space: the head sits
            // at the origin, so straight ahead is y = 0.
            o.position.set(0, 0, -0.5);
          }),
          children(
            component(() => {
              if (!presenting.get()) {
                return NOTHING;
              }
              return dom(ctx, panel, [
                effects((obj) => {
                  // A little above the group's origin, which puts the
                  // middle of the panel a touch under eye level once it is
                  // scaled down and pushed away.
                  obj.position.set(0, 1, 0);
                }),
              ]);
            })(),
          ),
        ]),
        cursors(ctx, { color: "#ff0000" }),
      ),
    ]);
  });

export default Scene;
