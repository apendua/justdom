import { afterEach, describe, expect, it } from "vitest";
import { mountFocusDiagnostics } from "./focusDiagnostics.js";

describe("mountFocusDiagnostics", () => {
  let dispose = () => {};
  afterEach(() => dispose());

  it("logs keys, telling the browser's from a script's, and focus in the card", () => {
    document.body.innerHTML = `<div id="root"><input id="field" /></div>`;
    const root = document.querySelector<HTMLElement>("#root")!;
    dispose = mountFocusDiagnostics(root);
    const field = document.querySelector<HTMLInputElement>("#field")!;
    field.focus();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    const log = root.querySelector("pre")!.textContent!;
    expect(log).toContain("virtualKeyboard: absent");
    expect(log).toContain("focusin input#field");
    expect(log).toContain('keydown "a" - scripted on input#field, active input#field');
  });

  it("keeps the last lines only, and goes with the log", () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const root = document.querySelector<HTMLElement>("#root")!;
    dispose = mountFocusDiagnostics(root);
    for (let i = 0; i < 30; i++) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: String(i) }));
    }
    const lines = root.querySelector("pre")!.textContent!.split("\n");
    expect(lines).toHaveLength(14);
    expect(lines.at(-1)).toContain('"29"');
    dispose();
    dispose = () => {};
    expect(root.querySelector("pre")).toBeNull();
  });

  it("puts the page's virtual keyboard setting back when it goes", () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const root = document.querySelector<HTMLElement>("#root")!;
    const keyboard = Object.assign(new EventTarget(), {
      overlaysContent: false,
      boundingRect: new DOMRect(0, 400, 800, 200),
    });
    Object.defineProperty(navigator, "virtualKeyboard", { value: keyboard, configurable: true });
    try {
      const stop = mountFocusDiagnostics(root);
      expect(keyboard.overlaysContent).toBe(true);
      keyboard.dispatchEvent(new Event("geometrychange"));
      expect(root.querySelector("pre")!.textContent).toContain("geometrychange: x=0 y=400 800x200");
      stop();
      expect(keyboard.overlaysContent).toBe(false);
    } finally {
      delete (navigator as { virtualKeyboard?: unknown }).virtualKeyboard;
    }
  });
});
