import { describe, expect, it, vi } from "vitest";
import { mountLookPicker } from "./lookPicker.js";
import { LOOKS } from "./looks.js";

function picker() {
  document.body.innerHTML = `<select></select>`;
  return document.querySelector("select")!;
}

describe("mountLookPicker", () => {
  it("lists every look, with the one that is up chosen", () => {
    const select = picker();
    const dispose = mountLookPicker(select, LOOKS[1], vi.fn());
    expect([...select.options].map((option) => option.value)).toEqual(LOOKS.map(({ id }) => id));
    expect(select.value).toBe(LOOKS[1].id);
    dispose();
  });

  it("hands over the look picked, and lets go of focus", () => {
    // A select that keeps focus takes every letter typed on the monitor
    // as type-ahead: a P typed in a command would pick Paper Studio.
    const select = picker();
    const onPick = vi.fn();
    const dispose = mountLookPicker(select, LOOKS[0], onPick);
    select.focus();
    select.value = "ops";
    select.dispatchEvent(new Event("change"));
    expect(onPick).toHaveBeenCalledWith(LOOKS.find(({ id }) => id === "ops"));
    expect(document.activeElement).not.toBe(select);
    dispose();
  });
});
