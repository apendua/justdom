import { canPresent } from "./session.js";

/**
 * The service worker this page was loaded under, if one served it: read as
 * the page loads, since a newer worker can take the page over at any time
 * after.
 */
const servedBy = navigator.serviceWorker?.controller ?? null;

/**
 * Which emulated headset the page's address asks for, if any:
 *
 * - `?touch`, for an app that passes `touch`, is the phone's: the headset
 *   without its panels, and the touch layer in front of it. An app that
 *   passes nothing ignores the flag, since its controls have not been tried
 *   on a phone, and the rest of the query decides.
 * - `?emulator=bare` is the headset without its panels, for a harness
 *   photographing the scene or driving it from a script.
 * - `?emulator=devui` is the headset with IWER's panels, on any screen.
 * - `?emulator`, with any other value or none, is the phone's on a browser
 *   whose main pointer is a finger (`coarse`), for an app that passes
 *   `touch`, and the one with panels everywhere else: the panels are drawn
 *   for a mouse, and too small to use on a phone.
 * - Without either flag, none.
 *
 * @param {URLSearchParams} query
 * @param {{ touch: boolean, coarse: boolean }} page Whether the app passes
 *   `touch`, and whether the page's main pointer is coarse.
 * @returns {"touch" | "devui" | "bare" | null}
 */
export function emulatorFor(query, { touch, coarse }) {
  if (touch && query.has("touch")) {
    return "touch";
  }
  if (!query.has("emulator")) {
    return null;
  }
  const value = query.get("emulator");
  if (value === "bare") {
    return "bare";
  }
  if (value === "devui") {
    return "devui";
  }
  return touch && coarse ? "touch" : "devui";
}

/**
 * Install the emulated headset the page's address asks for
 * (`emulatorFor`), and resolve once it is in, or at once when none is
 * asked for. The emulator and the touch layer are chunks of their own,
 * fetched only when asked for. A chunk that cannot be fetched is logged
 * rather than thrown, since the page works without a headset, and a page
 * a service worker served from an old deploy reloads into the new one
 * (`fetched`).
 *
 * `offerHeadset` calls this first. A page that offers its session another
 * way calls it before it renders, so `navigator.xr` is the emulator's by
 * the time three.js looks.
 *
 * @param {{ touch?: import("./touch.js").TouchOptions }} [options] The
 *   app's touch layer: its buttons and where the head starts. Passing it
 *   at all says the app's controls work on a phone.
 * @returns {Promise<void>}
 */
export async function installEmulator({ touch } = {}) {
  const flavor = emulatorFor(new URLSearchParams(location.search), {
    touch: touch !== undefined,
    coarse: globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
  });
  if (flavor === "touch") {
    try {
      const [{ install }, { installTouch }] = await Promise.all([
        fetched(import("./emulator.js")),
        fetched(import("./touch.js")),
      ]);
      installTouch(install({ devUI: false }), touch);
    } catch (err) {
      console.error("Could not install the XR emulator's touch mode:", err);
    }
  } else if (flavor) {
    try {
      const { install } = await fetched(import("./emulator.js"));
      install({ devUI: flavor === "devui" });
    } catch (err) {
      console.error("Could not install the XR emulator:", err);
    }
  }
}

/**
 * Offer the page a headset, if it can have one: load the scene with
 * `scene`, a dynamic import of the module that builds it, only once a
 * session is known to be possible, and resolve to that module, or to null
 * on a platform that cannot present. This module imports nothing from
 * three.js, so on a laptop the page is the page and nothing else is
 * fetched.
 *
 * It first installs the emulated headset the address asks for
 * (`installEmulator`), which is what makes the session drivable without
 * one: `?emulator`, `?emulator=bare`, `?emulator=devui` and `?touch`, as
 * `emulatorFor` says.
 *
 * If any of these chunks cannot be fetched because the page came from a
 * service worker's precache and a deploy has replaced the chunks it names,
 * the page reloads once the new worker has taken it over (see `fetched`).
 *
 * @template T
 * @param {() => Promise<T>} scene
 * @param {{ touch?: import("./touch.js").TouchOptions }} [options]
 * @returns {Promise<T | null>}
 */
export async function offerHeadset(scene, options = {}) {
  await installEmulator(options);
  if (!(await canPresent())) {
    return null;
  }
  return fetched(scene());
}

/**
 * A chunk the page imports lazily, which its service worker does not
 * precache: the emulator, the touch layer and the scene. A page the
 * worker serves after a deploy names them by hashes the new deployment no
 * longer has, so the import fails. The new worker takes the page over as
 * it activates (`autoUpdate`), and reloading then gets the page that names
 * the chunks the server has. A page whose worker has not been replaced has
 * no newer page to reload into, so it waits rather than loops.
 *
 * @template T
 * @param {Promise<T>} chunk
 * @returns {Promise<T>}
 */
async function fetched(chunk) {
  try {
    return await chunk;
  } catch (err) {
    reloadWhenReplaced();
    throw err;
  }
}

/** Whether a reload is already waiting on a newer worker. */
let reloading = false;

function reloadWhenReplaced() {
  const worker = navigator.serviceWorker;
  if (!worker || reloading) {
    return;
  }
  reloading = true;
  void replacedWorker(worker).then(() => location.reload());
}

/**
 * Settles once the page is controlled by a worker other than `servedBy`:
 * at once if that has already happened.
 *
 * @param {ServiceWorkerContainer} worker
 * @returns {Promise<void>}
 */
function replacedWorker(worker) {
  if (worker.controller !== servedBy) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    worker.addEventListener("controllerchange", () => resolve(), { once: true });
  });
}
