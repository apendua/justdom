import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
import AppStore from "../store/App";
import Canvas, { type CanvasOptions } from "./Canvas";

// jsdom lays nothing out, so it has no ResizeObserver for the canvas to ask
// for its size. The store's default size stands in.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  document.body.replaceChildren();
});

/**
 * The drawing of a construction line through two points, mounted as the page
 * mounts it, with the line tool's first click made and the cursor elsewhere,
 * so that the rubber band is drawn too.
 */
function mount(options?: CanvasOptions) {
  const store = new AppStore();
  store.setCode("A=point(0, 0);\nB=point(2, 0);\nl=line(A, B);\n");
  store.setTool("line");
  store.clickAt(0, 0);
  store.cursorWorld.set({ x: 1, y: 1 });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const subscription = just(host, [children(Canvas(store, options))]).subscribe({});
  const lines = [...host.querySelectorAll("line")];
  // The two axes come first and the rubber band last.
  const construction = lines[2];
  const rubberBand = lines[lines.length - 1];
  return { construction, rubberBand, subscription };
}

describe("the drawing's dashes", () => {
  it("draws construction lines and the rubber band solid by default", () => {
    const { construction, rubberBand, subscription } = mount();
    expect(construction.getAttribute("stroke-dasharray")).toBe("");
    expect(rubberBand.getAttribute("visibility")).toBe("visible");
    expect(rubberBand.getAttribute("stroke-dasharray")).toBe("");
    subscription.unsubscribe();
  });

  it("dashes them when asked to", () => {
    const { construction, rubberBand, subscription } = mount({ dashes: true });
    expect(construction.getAttribute("stroke-dasharray")).toBe("5 4");
    expect(rubberBand.getAttribute("stroke-dasharray")).toBe("4 4");
    subscription.unsubscribe();
  });
});
