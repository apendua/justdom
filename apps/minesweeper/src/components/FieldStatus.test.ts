import { describe, expect, it } from "vitest";
import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
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

/** The elements `FieldStatus` draws for `target`, inside an `<svg>`. */
function draw(target: Field): Element[] {
  const viewport = new Viewport({ allFields: [target], screenWidth: 100, screenHeight: 100 });
  const ctx = ViewportContext.set({}, viewport);
  const svg = document.createElementNS(SVG_NS, "svg");
  just(svg, [children(FieldStatus(ctx, target))]).subscribe({
    error: (err) => {
      throw err;
    },
  });
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
    expect(url).toMatch(/^data:image\/svg\+xml,/);
  });

  it("draws a count as text", () => {
    const drawn = draw(field({ uncovered: true, nMines: 3 }));
    expect(drawn.map((element) => element.tagName)).toEqual(["text"]);
    expect(drawn[0].textContent).toBe("3");
  });
});
