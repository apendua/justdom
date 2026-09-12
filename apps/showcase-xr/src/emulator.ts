import { XRDevice, metaQuest3 } from "iwer";
import { DevUI } from "@iwer/devui";

export interface EmulatorOptions {
  /**
   * Whether to install the dev UI — the headset and controller panels drawn
   * over the scene. On for a person driving the demo by hand, off for a test
   * that is photographing what the scene looks like and wants nothing else in
   * the frame.
   */
  devUI?: boolean;
}

export function install({ devUI = true }: EmulatorOptions = {}) {
  console.log("Installing emulator");
  const xrDevice = new XRDevice(metaQuest3);
  // Desktop browsers have a navigator.xr of their own that supports nothing,
  // and IWER steps aside for it unless told not to; the whole point of asking
  // for the emulator is to have it stand in for that.
  xrDevice.installRuntime({ forceInstall: true });
  if (devUI) {
    xrDevice.installDevUI(DevUI);
  }
  // The emulated headset is the only handle a test has on where the viewer is
  // standing and what the controllers are doing. It is reachable only from a
  // page that asked for the emulator in the first place, which is the same
  // bargain the dev UI strikes.
  (window as unknown as { xrDevice?: XRDevice }).xrDevice = xrDevice;
  return xrDevice;
}
