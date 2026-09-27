import * as THREE from "three";
import { children, cursors, $, dom, getScene } from "@apendua/freedom";
import { effects, effectsOnly, useEffects } from "@apendua/signal";
import TodoKeyboard from "./TodoKeyboard.js";

/**
 * The scene: the page's own todo element, mirrored into a panel in front of
 * the viewer, with a keyboard on offer for its field.
 *
 * Nothing here builds UI. The element handed in is the one the page mounted
 * the app into and is showing right now; `dom(ctx, element)` watches it
 * where it stands, so what the headset shows is what the page shows, the
 * same nodes, and a press on the mirrored Add button is a click on the real
 * one. The one thing the scene adds is the keyboard, which a page does not
 * need and a headset cannot do without: `TodoKeyboard` says what it looks
 * like, the portal says when it appears and where it hangs.
 */
export const Scene = (panel: HTMLElement) =>
  effectsOnly((ctx: WeakKey) => {
    // Portal px are a centimetre each; a tenth of that makes the 464px card
    // about 46 cm wide, at half a metre — a tablet held out in front of you.
    const scale = 0.1;

    useEffects(getScene(ctx), [
      children(
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
            dom(
              ctx,
              panel,
              [
                effects((obj) => {
                  // A little above the group's origin, which puts the middle
                  // of the panel a touch under eye level once it is scaled
                  // down and pushed away, and leaves the keyboard the room
                  // below it that the portal hangs it in.
                  obj.position.set(0, 1, 0);
                }),
              ],
              {
                keyboard: {
                  create: ({ onKey }) => TodoKeyboard({ onKey }),
                },
              },
            ),
          ),
        ]),
        cursors(ctx, { color: "#ff0000" }),
      ),
    ]);
  });

export default Scene;
