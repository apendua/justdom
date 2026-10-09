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
});
