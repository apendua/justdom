import { describe, expect, it } from "vitest";
import { mountSwatches } from "./swatches.js";

describe("mountSwatches", () => {
  it("sets the swatch's colour on every accentable panel, and marks the swatch", () => {
    document.body.innerHTML = `
      <div id="desk">
        <div id="monitor" data-accentable data-accent="tomato"></div>
        <div id="board" data-accentable data-accent="tomato">
          <div data-swatch="tomato" data-selected></div>
          <div data-swatch="cobalt"><i></i></div>
        </div>
        <div id="plain"></div>
      </div>`;
    const desk = document.querySelector<HTMLElement>("#desk")!;
    const dispose = mountSwatches(desk);
    desk.querySelector<HTMLElement>('[data-swatch="cobalt"] i')!.click();
    expect(desk.querySelector("#monitor")!.getAttribute("data-accent")).toBe("cobalt");
    expect(desk.querySelector("#board")!.getAttribute("data-accent")).toBe("cobalt");
    expect(desk.querySelector("#plain")!.hasAttribute("data-accent")).toBe(false);
    expect(desk.querySelector('[data-swatch="tomato"]')!.hasAttribute("data-selected")).toBe(false);
    expect(desk.querySelector('[data-swatch="cobalt"]')!.hasAttribute("data-selected")).toBe(true);
    dispose();
  });
});
