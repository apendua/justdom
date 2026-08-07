import { XRDevice, metaQuest3 } from "iwer";
import { DevUI } from "@iwer/devui";

export function install() {
  console.log("Installing emulator");
  const xrDevice = new XRDevice(metaQuest3);
  xrDevice.installRuntime();
  xrDevice.installDevUI(DevUI);
}
