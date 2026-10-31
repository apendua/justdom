import { canPresent } from "./session.js";

/**
 * The service worker this page was loaded under, if one served it: read as
 * the page loads, since a newer worker can take the page over at any time
 * after.
 */
const servedBy = navigator.serviceWorker?.controller ?? null;

/**
 * Offer the page a headset, if it can have one: load the scene with
 * `scene`, a dynamic import of the module that builds it, only once a
 * session is known to be possible, and resolve to that module, or to null
 * on a platform that cannot present. This module imports nothing from
 * three.js, so on a laptop the page is the page and nothing else is
 * fetched.
 *
 * `?emulator` installs a headset in the browser first, which is what makes
 * the session drivable by hand without one; `?emulator=bare` installs the
 * runtime without the panels that drive it, for a harness photographing the
 * scene or driving it from a script.
 *
 * If either chunk cannot be fetched because the page came from a service
 * worker's precache and a deploy has replaced the chunks it names, the page
 * reloads once the new worker has taken it over (see `fetched`).
 *
 * @template T
 * @param {() => Promise<T>} scene
 * @returns {Promise<T | null>}
 */
export async function offerHeadset(scene) {
  const query = new URLSearchParams(location.search);
  if (query.has("emulator")) {
    try {
      const { install } = await fetched(import("./emulator.js"));
      install({ devUI: query.get("emulator") !== "bare" });
    } catch (err) {
      console.error("Could not install the XR emulator:", err);
    }
  }
  if (!(await canPresent())) {
    return null;
  }
  return fetched(scene());
}

/**
 * A chunk the page imports lazily, which its service worker does not
 * precache: the emulator and the scene. A page the worker serves after a
 * deploy names them by hashes the new deployment no longer has, so the
 * import fails. The new worker takes the page over as it activates
 * (`autoUpdate`), and reloading then gets the page that names the chunks
 * the server has. A page whose worker has not been replaced has no newer
 * page to reload into, so it waits rather than loops.
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
