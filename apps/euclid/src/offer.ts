import { canPresent } from "@apendua.dev/headset/session";

/** The three elements the app is mounted in, each a panel in a session. */
export interface Mounts {
  toolbar: HTMLElement;
  editor: HTMLElement;
  canvas: HTMLElement;
}

/**
 * Offer the page a headset, if it can have one: the scene in `xr.ts`, which
 * mirrors the three mount points into panels, loaded only once a session is
 * known to be possible. This module imports nothing from three.js, so on a
 * laptop the page is the page and nothing else is fetched.
 *
 * `?emulator` installs a headset in the browser first, which is what makes
 * the session drivable by hand without one; `?emulator=bare` installs the
 * runtime without the panels that drive it, for a harness photographing the
 * scene.
 */
export async function offerHeadset(mounts: Mounts): Promise<void> {
  const query = new URLSearchParams(location.search);
  if (query.has("emulator")) {
    try {
      const { install } = await import("@apendua.dev/headset/emulator");
      install({ devUI: query.get("emulator") !== "bare" });
    } catch (err) {
      console.error("Could not install the XR emulator:", err);
    }
  }
  if (!(await canPresent())) {
    return;
  }
  const { offerXR } = await import("./xr");
  offerXR(mounts);
}
