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
  const { offerXR } = await import("./xr");
  offerXR(board, menu);
}
