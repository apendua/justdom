import { XRDevice, metaQuest3 } from "iwer";
import { DevUI } from "@iwer/devui";

declare global {
  interface Window {
    /**
     * The emulated headset, so the game can be driven from outside the page:
     * poses and buttons pushed in, the running scene read back. This is how the
     * build flow and the slingshot are exercised in a headless browser.
     */
    xrDevice?: XRDevice;
  }
}

export function install(options: { devui?: boolean } = {}) {
  console.log("Installing emulator");
  const { devui = true } = options;
  const xrDevice = new XRDevice(metaQuest3);
  // Desktop browsers have a navigator.xr of their own that supports nothing,
  // and IWER steps aside for it unless told not to; the whole point of asking
  // for the emulator is to have it stand in for that.
  xrDevice.installRuntime({ forceInstall: true });
  if (devui) {
    // The DevUI drives the headset and controller poses from its own panels,
    // so it is skipped when a script wants to set the poses itself.
    xrDevice.installDevUI(DevUI);
  }
  // Handy for driving the emulated headset and controllers from scripts.
  window.xrDevice = xrDevice;
}
