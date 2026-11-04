import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import { $ } from "justdom-three";
import { addDependency, component, effects, onCleanup, Stream } from "justdom-signal";
import { backdropShown } from "./session.js";

/**
 * @import { Component } from "justdom-three";
 * @import { Source } from "justdom-signal";
 */

const backdropGeometry = new THREE.SphereGeometry(10, 32, 16);

/**
 * What a session is set against unless the room is asked for: one colour,
 * all the way round, taken down by the page's passthrough switch
 * (`backdropShown`).
 *
 * `scene.background` cannot do this alone. In an `alpha-blend` session three
 * clears the frame to transparent whatever the background says, so that
 * the passthrough shows, which is the point of AR and the opposite of a
 * backdrop. An opaque sphere round the viewer is a background three has no
 * rule about: everything else in the scene is drawn over it, and nothing of
 * the room shows through. A scene sets its `background` to the same colour
 * for a VR session, where three honours it.
 *
 * It is drawn first and takes no part in the depth test, so it cannot
 * z-fight with anything or come through it at the foveated rim of the view.
 * Ten metres out, inside the camera's far plane of twenty, and too far for
 * a player to walk out of in a session that stays near its origin.
 *
 * @type {(color: THREE.ColorRepresentation) => Source<Component>}
 */
export const Backdrop = component(
  /** @param {THREE.ColorRepresentation} color */
  (color) => {
    // One per mount, since the colour is the caller's, and let go with it.
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    onCleanup(() => material.dispose());
    return $(new THREE.Mesh(backdropGeometry, material), [
      effects((o) => {
        o.renderOrder = -1;
        o.frustumCulled = false;
        o.visible = backdropShown();
      }),
    ]);
  },
);

/**
 * The models `render()` draws for the controllers and the tracked hands,
 * spread into `render()`'s options. Both factories fetch the WebXR input
 * profiles when a controller or hand connects. With no argument they fetch
 * them from three's default, the jsDelivr CDN, so a headset with no network
 * draws neither.
 *
 * `profiles` names a copy of that tree the app serves itself, such as
 * `` `${import.meta.env.BASE_URL}profiles` ``, resolved against the page's
 * address. The models then come from the app's own origin, and a headset
 * with no network draws them if the app's service worker precaches the
 * `.glb` and `.json` files under it. The tree has the layout of
 * `@webxr-input-profiles/assets`' `dist/profiles`.
 *
 * @param {string} [profiles]
 * @returns {{
 *   createControllerModel: (grip: THREE.XRGripSpace) => THREE.Object3D,
 *   createHandModel: (hand: THREE.XRHandSpace) => THREE.Object3D,
 * }}
 */
export function inputModels(profiles) {
  const controllers = new XRControllerModelFactory();
  const hands = new XRHandModelFactory();
  if (profiles !== undefined) {
    const path = new URL(profiles, location.href).href.replace(/\/$/, "");
    // The two paths are spelled differently on purpose: the controller
    // factory joins `/profilesList.json` onto its own, and the hand model
    // joins `<handedness>.glb` onto its own with no separator.
    controllers.setPath(path);
    hands.setPath(`${path}/generic-hand/`);
  }
  return {
    createControllerModel: (grip) => controllers.createControllerModel(grip),
    createHandModel: (hand) => hands.createHandModel(hand, "mesh"),
  };
}

/**
 * One stream of resizes per element, kept so that a reader that runs again
 * on a resize finds the stream it already holds, rather than a new one
 * whose new observer reports the element's size as it starts observing,
 * which would run the reader again, for ever.
 *
 * @type {WeakMap<Element, Stream<ResizeObserverEntry[]>>}
 */
const resizes = new WeakMap();

/**
 * The element's client rect, read again whenever its size changes: called
 * inside a computation, such as a panel's `effects`, it runs that again on
 * each resize. A window resize that refits the page reaches a panel this
 * way, so a scale worked out from the rect follows the element's new size
 * during a session rather than keeping the one it had as the session
 * started.
 *
 * @param {Element} element
 * @returns {DOMRect}
 */
export function clientRect(element) {
  let stream = resizes.get(element);
  if (!stream) {
    stream = new Stream((subscriber) => {
      const observer = new ResizeObserver((entries) => subscriber.next(entries));
      observer.observe(element, { box: "border-box" });
      return () => observer.disconnect();
    });
    resizes.set(element, stream);
  }
  addDependency(stream);
  return element.getBoundingClientRect();
}
