import { describe, expect, it, onTestFinished } from "vitest";
import { children } from "justdom";
import { just } from "justdom-signal";
import type { Field } from "../store/Fields";
import Viewport, { ViewportContext } from "../store/Viewport";
import FieldStatus, { FLAG_URL, MINE_URL } from "./FieldStatus";

const SVG_NS = "http://www.w3.org/2000/svg";

/** What `FieldStatus` reads of a field, and nothing else. */
function field(state: Partial<Pick<Field, "uncovered" | "flag" | "mine" | "nMines">>): Field {
  return {
    x: 0,
    y: 0,
    z: 0,
    uncovered: false,
    flag: false,
    mine: false,
    nMines: 0,
    ...state,
  } as Field;
}

/** Mount `tree` into `element` until the test finishes. */
function mount(element: Element, ...trees: Parameters<typeof children>): void {
  const subscription = just(element, [children(...trees)]).subscribe({
    error: (err) => {
      throw err;
    },
  });
  onTestFinished(() => subscription.unsubscribe());
}

/** The elements `FieldStatus` draws for `target`, inside an `<svg>`. */
function draw(target: Field): Element[] {
  const viewport = new Viewport({ allFields: [target], screenWidth: 100, screenHeight: 100 });
  const ctx = ViewportContext.set({}, viewport);
  const svg = document.createElementNS(SVG_NS, "svg");
  mount(svg, FieldStatus(ctx, target));
  return [...svg.querySelectorAll("*")];
}

describe("FieldStatus", () => {
  // A lost game uncovers every mine at once, and the headset builds meshes
  // for each shape it mirrors: one picture per field keeps that to a quad.
  it.each([
    ["mine", field({ uncovered: true, mine: true }), MINE_URL],
    ["flag", field({ flag: true }), FLAG_URL],
  ])("draws a %s as one image of a shared picture", (_, target, url) => {
    const drawn = draw(target);
    expect(drawn.map((element) => element.tagName)).toEqual(["image"]);
    expect(drawn[0].getAttribute("href")).toBe(url);
  });

  it("draws a count as text", () => {
    const drawn = draw(field({ uncovered: true, nMines: 3 }));
    expect(drawn.map((element) => element.tagName)).toEqual(["text"]);
    expect(drawn[0].textContent).toBe("3");
  });

  // A picture whose markup does not parse draws nothing, on the page and in
  // the headset alike, and nothing else here would notice.
  it.each([
    ["mine", MINE_URL],
    ["flag", FLAG_URL],
  ])("the %s's picture is an SVG with a size of its own", (_, url) => {
    const prefix = "data:image/svg+xml,";
    expect(url.startsWith(prefix)).toBe(true);
    const parsed = new DOMParser().parseFromString(
      decodeURIComponent(url.slice(prefix.length)),
      "image/svg+xml",
    );
    expect(parsed.getElementsByTagName("parsererror")).toHaveLength(0);
    const root = parsed.documentElement;
    expect([root.namespaceURI, root.localName]).toEqual([SVG_NS, "svg"]);
    // freedom draws an SVG with no size of its own at 300 by 150.
    expect(Number(root.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(root.getAttribute("height"))).toBeGreaterThan(0);
  });
});
