import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
import AppStore, { type PendingStep } from "../store/App";
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
 * The drawing of a construction line and a construction circle, mounted as
 * the page mounts it, with the first click of `tool` made and the cursor
 * elsewhere, so that the tool's rubber band is drawn too.
 */
function mount(tool: PendingStep["tool"], options?: CanvasOptions) {
  const store = new AppStore();
  store.setCode("A=point(0, 0);\nB=point(2, 0);\nl=line(A, B);\nc=circle(A, B-A);\n");
  store.setTool(tool);
  store.clickAt(0, 0);
  store.cursorWorld.set({ x: 1, y: 1 });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const subscription = just(host, [children(Canvas(store, options))]).subscribe({});
  const svg = host.querySelector("svg") as SVGSVGElement;
  // The two axes come first, then the items, curves before points, and the
  // rubber bands last: the line's, then the circle's.
  const [, , constructionLine, constructionCircle] = [...svg.children];
  const [lineBand, circleBand] = [...(svg.lastElementChild?.children ?? [])];
  const band = tool === "line" ? lineBand : circleBand;
  return { constructionLine, constructionCircle, band, subscription };
}

/** Every tool that draws a rubber band. */
const tools: PendingStep["tool"][] = ["line", "circle"];

describe("the drawing's dashes", () => {
  for (const tool of tools) {
    it(`dashes construction lines and the ${tool}'s rubber band by default`, () => {
      const { constructionLine, constructionCircle, band, subscription } = mount(tool);
      expect(constructionLine.localName).toBe("line");
      expect(constructionLine.getAttribute("stroke-dasharray")).toBe("5 4");
      expect(constructionCircle.localName).toBe("circle");
      expect(constructionCircle.getAttribute("stroke-dasharray")).toBe("5 4");
      expect(band.localName).toBe(tool);
      expect(band.getAttribute("visibility")).toBe("visible");
      expect(band.getAttribute("stroke-dasharray")).toBe("4 4");
      subscription.unsubscribe();
    });

    it(`draws construction lines and the ${tool}'s rubber band solid with dashes off`, () => {
      const { constructionLine, constructionCircle, band, subscription } = mount(tool, {
        dashes: false,
      });
      expect(constructionLine.getAttribute("stroke-dasharray")).toBe("");
      expect(constructionCircle.getAttribute("stroke-dasharray")).toBe("");
      expect(band.getAttribute("stroke-dasharray")).toBe("");
      subscription.unsubscribe();
    });
  }
});
