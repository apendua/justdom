import { XRDevice, metaQuest3 } from "iwer";
import { DevUI } from "@iwer/devui";

declare global {
  interface Window {
    /** So the headset and controllers can be driven from a script. */
    xrDevice?: XRDevice;
  }
}

/**
 * A fake headset with two controllers, for running in an ordinary browser. The
 * DevUI is the panel that moves them about; a script driving them itself wants
 * it left out, since it writes a pose of its own every frame.
 */
export function install(devui = true) {
  const xrDevice = new XRDevice(metaQuest3);
  // Desktop browsers have a navigator.xr of their own that supports nothing,
  // and IWER steps aside for it unless told not to; the whole point of asking
  // for the emulator is to have it stand in for that.
  xrDevice.installRuntime({ forceInstall: true });
  if (devui) {
    xrDevice.installDevUI(DevUI);
  }
  window.xrDevice = xrDevice;
}
