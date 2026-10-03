/**
 * The service worker this page was loaded under, if one served it: read as
 * the page loads, since a newer worker can take the page over at any time
 * after.
 */
const servedBy = navigator.serviceWorker?.controller ?? null;

/**
 * Whether this platform can open an immersive session at all. Asked before
 * the scene is loaded: a page that cannot go anywhere should not fetch
 * three.js, run a render loop or wear a button that says so.
 */
async function canPresent(): Promise<boolean> {
  const xr = navigator.xr;
  if (!xr) {
    return false;
  }
  for (const mode of ["immersive-ar", "immersive-vr"] as const) {
    if (await xr.isSessionSupported(mode).catch(() => false)) {
      return true;
    }
  }
  return false;
}

/**
 * Offer the page a headset, if it can have one: the scene in `xr.ts`, which
 * mirrors `board` and `menu` into two panels, loaded only once a session is
 * known to be possible. This module imports nothing from three.js, so on a
 * laptop the page is the page and nothing else is fetched.
 *
 * If the scene cannot be fetched because the page came from the service
 * worker's precache and a deploy has replaced the chunks it names, the page
 * reloads once the new worker has taken it over.
 *
 * `?emulator` installs a headset in the browser first, which is what makes
 * the session drivable by hand without one; `?emulator=bare` installs the
 * runtime without the panels that drive it, for a harness photographing the
 * scene.
 */
export async function offerHeadset(board: HTMLElement, menu: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  if (query.has("emulator")) {
    try {
      const { install } = await import("./emulator");
      install({ devUI: query.get("emulator") !== "bare" });
    } catch (err) {
      console.error("Could not install the XR emulator:", err);
    }
  }
  if (!(await canPresent())) {
    return;
  }
  const worker = navigator.serviceWorker;
  let scene: typeof import("./xr");
  try {
    scene = await import("./xr");
  } catch (err) {
    // The service worker precaches the page but not the scene, so a page it
    // serves after a deploy names the scene by a hash the new deployment no
    // longer has. The new worker takes over the page as it activates
    // (`autoUpdate`); reloading then gets the page that names the chunks
    // the server has. A page whose worker has not been replaced has no
    // newer page to reload into, so it waits rather than loops.
    if (worker) {
      void replacedWorker(worker).then(() => location.reload());
    }
    throw err;
  }
  scene.offerXR(board, menu);
}

/**
 * Settles once the page is controlled by a worker other than `servedBy`:
 * at once if that has already happened.
 */
function replacedWorker(worker: ServiceWorkerContainer): Promise<void> {
  if (worker.controller !== servedBy) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    worker.addEventListener("controllerchange", () => resolve(), { once: true });
  });
}
