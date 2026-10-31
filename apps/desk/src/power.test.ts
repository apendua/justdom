import { describe, expect, it, vi } from "vitest";
import { Signal } from "justdom-signal";
import { mountPowerButton } from "./power.js";

describe("mountPowerButton", () => {
  it("ends the session it is pressed in", () => {
    const button = document.createElement("div");
    const end = vi.fn(() => Promise.resolve());
    const session = Signal.of<XRSession | null>({ end } as unknown as XRSession);
    const dispose = mountPowerButton(button, session);
    button.click();
    expect(end).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does nothing on the page", () => {
    const button = document.createElement("div");
    const dispose = mountPowerButton(button, Signal.of<XRSession | null>(null));
    expect(() => button.click()).not.toThrow();
    dispose();
  });
});
