import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { typeIntoInput } from "justdom-three";
import { mountKeyboard } from "./keyboard.js";
import { standInForPointerEvent } from "./test/pointerEvent.js";

beforeAll(standInForPointerEvent);

/** A pointer going down on an element, as a ray's trigger closing on it sends it. */
function down(element: Element, init: PointerEventInit = {}) {
  element.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, button: 0, ...init }),
  );
}

/** The pointer's release, cancel or leave on an element. */
function up(element: Element, type = "pointerup", pointerId = 2) {
  element.dispatchEvent(new PointerEvent(type, { bubbles: type !== "pointerleave", pointerId }));
}

/** A key pressed and let go, and the click that follows. */
function tap(element: HTMLElement) {
  down(element);
  up(element);
  element.click();
}

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

  it("types a pressed key, and holds it down for a moment", () => {
    vi.useFakeTimers();
    const keys = board();
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const q = keys.querySelector<HTMLElement>('[data-key="q"] .cap')!;
    tap(q);
    expect(onKey.mock.calls).toEqual([["q"]]);
    const cap = q.parentElement!;
    expect(cap.hasAttribute("data-down")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(cap.hasAttribute("data-down")).toBe(false);
  });

  it("types a key as the pointer goes down, and again while it is held", () => {
    vi.useFakeTimers();
    const keys = board();
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const cap = keys.querySelector<HTMLElement>('[data-key="Backspace"]')!;
    down(cap.querySelector(".cap")!);
    expect(onKey.mock.calls).toEqual([["Backspace"]]);
    vi.advanceTimersByTime(499);
    expect(onKey).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(101);
    expect(onKey).toHaveBeenCalledTimes(4);
    expect(cap.hasAttribute("data-down"), "down while it repeats").toBe(true);
    up(cap.querySelector(".cap")!);
    vi.advanceTimersByTime(1000);
    expect(onKey).toHaveBeenCalledTimes(4);
  });

  it("stops repeating when the pointer leaves the key, not its legend", () => {
    vi.useFakeTimers();
    const keys = board();
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const cap = keys.querySelector<HTMLElement>('[data-key="x"]')!;
    down(cap.querySelector(".cap")!);
    up(cap.querySelector(".cap")!, "pointerleave");
    vi.advanceTimersByTime(500);
    expect(onKey).toHaveBeenCalledTimes(2);
    up(cap, "pointerleave");
    vi.advanceTimersByTime(1000);
    expect(onKey).toHaveBeenCalledTimes(2);
  });

  it("types Enter and the modifiers once, however long they are held", () => {
    vi.useFakeTimers();
    const keys = board();
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    for (const key of ["Enter", "Shift", "CapsLock"]) {
      down(keys.querySelector(`[data-key="${key}"]`)!);
      vi.advanceTimersByTime(1000);
    }
    expect(onKey.mock.calls).toEqual([["Enter"], ["Shift"], ["CapsLock"]]);
  });

  it("stops repeating when it is disposed of", () => {
    vi.useFakeTimers();
    const keys = board();
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    down(keys.querySelector('[data-key="z"]')!);
    dispose();
    dispose = () => {};
    vi.advanceTimersByTime(1000);
    expect(onKey).toHaveBeenCalledTimes(1);
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
    tap(keys.querySelector<HTMLElement>('[data-key="a"]')!);
    tap(keys.querySelector<HTMLElement>('[data-key=" "]')!);
    tap(keys.querySelector<HTMLElement>('[data-key="b"]')!);
    tap(keys.querySelector<HTMLElement>('[data-key="Backspace"]')!);
    expect(field.value).toBe("a ");
    expect(inputs).toHaveBeenCalledTimes(4);
    // A real key in a field is the browser's to type, and the cap goes down
    // with it.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(onKey).not.toHaveBeenCalled();
    expect(keys.querySelector('[data-key="x"]')!.hasAttribute("data-down")).toBe(true);
  });

  it("types on the monitor when a checkbox has focus, and leaves the box alone", () => {
    // A click focuses a checkbox, as on the ship list, and a checkbox is no
    // field to type into.
    document.body.innerHTML = `<div data-keys></div><input id="box" type="checkbox" />`;
    const keys = document.querySelector<HTMLElement>("[data-keys]")!;
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const box = document.querySelector<HTMLInputElement>("#box")!;
    box.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "h" }));
    tap(keys.querySelector<HTMLElement>('[data-key="e"]')!);
    expect(onKey.mock.calls).toEqual([["h"], ["e"]]);
    expect(box.value).toBe("on");
  });

  it("keeps a focused select from taking the monitor's letters as type-ahead", () => {
    // The Look menu keeps focus after it is opened. A letter it took as
    // type-ahead would pick another look: the P of LOAD PLOT.BAS, Paper
    // Studio. A browser leaves type-ahead out when keydown is cancelled.
    document.body.innerHTML = `<div data-keys></div>
      <select><option value="ops">Night Ops</option><option value="paper">Paper Studio</option></select>`;
    const keys = document.querySelector<HTMLElement>("[data-keys]")!;
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const select = document.querySelector("select")!;
    select.focus();
    const event = new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true });
    select.dispatchEvent(event);
    expect(onKey).toHaveBeenCalledWith("p");
    expect(event.defaultPrevented, "the select would jump to Paper Studio").toBe(true);
  });

  it("leaves a key that types nothing to the browser while the select has focus", () => {
    // F5 reloads, Alt+Left goes back and the arrows step through the menu:
    // none of them is a character the select would take as type-ahead.
    document.body.innerHTML = `<div data-keys></div><select><option>Night Ops</option></select>`;
    const keys = document.querySelector<HTMLElement>("[data-keys]")!;
    dispose = mountKeyboard(keys, { onKey: vi.fn() });
    const select = document.querySelector("select")!;
    select.focus();
    for (const key of ["F5", "ArrowDown", "ArrowLeft"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      select.dispatchEvent(event);
      expect(event.defaultPrevented, `${key} should be the browser's`).toBe(false);
    }
  });

  it("leaves a letter to the browser as well when nothing has focus", () => {
    const keys = board();
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const event = new KeyboardEvent("keydown", { key: "p", cancelable: true });
    window.dispatchEvent(event);
    expect(onKey).toHaveBeenCalledWith("p");
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves a field a session's keyboard types into to that keyboard", () => {
    // In a session the note field has no focus: justdom-three's own board types
    // into it, dispatching each key's keydown on the field, and the keydown
    // bubbles up to the window this keyboard listens on.
    const keys = board();
    keys.parentElement!.append(document.createElement("select"));
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    // Something else has focus, as the Look menu may.
    document.querySelector("select")!.focus();
    const field = document.querySelector<HTMLInputElement>("#field")!;
    for (const key of ["h", "i", " ", "x", "Backspace"]) {
      typeIntoInput(field, { key });
    }
    expect(field.value).toBe("hi ");
    expect(onKey).not.toHaveBeenCalled();
    expect(keys.querySelector("[data-down]")).toBeNull();
  });

  it("leaves a number field a session's keyboard types into to that keyboard", () => {
    const keys = board();
    const field = document.querySelector<HTMLInputElement>("#field")!;
    field.type = "number";
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    for (const key of ["1", "2", "Backspace"]) {
      typeIntoInput(field, { key });
    }
    expect(field.value).toBe("1");
    expect(onKey).not.toHaveBeenCalled();
  });

  it("leaves a key a script aims at any element without focus to that element", () => {
    const keys = board();
    const button = document.createElement("button");
    keys.parentElement!.append(button);
    const onKey = vi.fn();
    dispose = mountKeyboard(keys, { onKey });
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(onKey).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
