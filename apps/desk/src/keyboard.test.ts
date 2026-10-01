import { afterEach, describe, expect, it, vi } from "vitest";
import { mountKeyboard } from "./keyboard.js";

function board() {
  document.body.innerHTML = `<div data-keys></div><input id="field" />`;
  return document.querySelector<HTMLElement>("[data-keys]")!;
}

describe("mountKeyboard", () => {
  let dispose = () => {};
  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  it("lays out five rows of keys with their legends", () => {
    const keys = board();
    dispose = mountKeyboard(keys, { onKey: vi.fn() });
    expect(keys.querySelectorAll(".krow")).toHaveLength(5);
    const enter = keys.querySelector<HTMLElement>('[data-key="Enter"]')!;
    expect(enter.textContent).toBe("RETURN");
    expect(enter.classList.contains("accent")).toBe(true);
    expect(keys.querySelector('[data-key="q"]')!.textContent).toBe("Q");
  });

  it("types a clicked key, and holds it down for a moment", () => {
    vi.useFakeTimers();
    const keys = board();
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const q = keys.querySelector<HTMLElement>('[data-key="q"] .cap')!;
    q.click();
    expect(onKey).toHaveBeenCalledWith("q");
    const cap = q.parentElement!;
    expect(cap.hasAttribute("data-down")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(cap.hasAttribute("data-down")).toBe(false);
  });

  it("types a real key and presses its cap", () => {
    const keys = board();
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const event = new KeyboardEvent("keydown", { key: "Backspace", cancelable: true });
    window.dispatchEvent(event);
    expect(onKey).toHaveBeenCalledWith("Backspace");
    expect(event.defaultPrevented, "Backspace should not navigate back").toBe(true);
    expect(keys.querySelector('[data-key="Backspace"]')!.hasAttribute("data-down")).toBe(true);
  });

  it("keeps Enter from pressing the button that has focus", () => {
    document.body.innerHTML = `<div data-keys></div><button id="session">STOP AR</button>`;
    const keys = document.querySelector<HTMLElement>("[data-keys]")!;
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    document.querySelector<HTMLButtonElement>("#session")!.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    window.dispatchEvent(event);
    expect(onKey).toHaveBeenCalledWith("Enter");
    expect(event.defaultPrevented, "Enter would press the focused session button").toBe(true);
  });

  it("types into the field that has focus, and not on the monitor", () => {
    const keys = board();
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const field = document.querySelector<HTMLInputElement>("#field")!;
    field.focus();
    const inputs = vi.fn();
    field.addEventListener("input", inputs);
    keys.querySelector<HTMLElement>('[data-key="a"]')!.click();
    keys.querySelector<HTMLElement>('[data-key=" "]')!.click();
    keys.querySelector<HTMLElement>('[data-key="b"]')!.click();
    keys.querySelector<HTMLElement>('[data-key="Backspace"]')!.click();
    expect(field.value).toBe("a ");
    expect(inputs).toHaveBeenCalledTimes(4);
    // A real key in a field is the browser's to type.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(onKey).not.toHaveBeenCalled();
  });
});
