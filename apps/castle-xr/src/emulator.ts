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
  // From 2.2 on, IWER politely defers to a native `navigator.xr` unless
  // forced — and headless Chromium has a native one that supports nothing,
  // which is exactly where this emulator gets used. The installed 2.1 ignores
  // the option (hence the cast); the day the dependency moves, this line is
  // the difference between the screenshot scripts working and a session that
  // silently never starts.
  // TODO: Remove the type casting as soon as we actually migrate to IWER 2.2
  xrDevice.installRuntime({ forceInstall: true } as unknown as Parameters<
    typeof xrDevice.installRuntime
  >[0]);
  if (devui) {
    // The DevUI drives the headset and controller poses from its own panels,
    // so it is skipped when a script wants to set the poses itself.
    xrDevice.installDevUI(DevUI);
  }
  // Handy for driving the emulated headset and controllers from scripts.
  window.xrDevice = xrDevice;
}
