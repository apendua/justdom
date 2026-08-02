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

export interface EmulatorOptions {
  /**
   * The dev UI drives the controllers itself, one pose per frame, which is
   * exactly what a script driving them from outside does not want. Turning it
   * off leaves the emulated headset under the control of whoever is holding it.
   */
  devUI?: boolean;
}

export function install({ devUI = true }: EmulatorOptions = {}) {
  console.log("Installing emulator");
  const xrDevice = new XRDevice(metaQuest3);
  xrDevice.installRuntime();
  if (devUI) {
    xrDevice.installDevUI(DevUI);
  }
  window.xrDevice = xrDevice;
}
