import { describe, expect, it } from "vitest";
import AppStore from "./App";

function makeStore(code: string): AppStore {
  const store = new AppStore();
  store.setCode(code);
  store.viewSize.set({ width: 800, height: 600 });
  store.viewport.set({ centerX: 0, centerY: 0, scale: 50 });
  return store;
}

describe("AppStore", () => {
  it("parses and evaluates the code reactively", () => {
    const store = makeStore("A=point(0, 0);\nB=point(2, 0);\nl=line(A, B);\n");
    expect(store.parsed.get().error).toBeNull();
    expect(store.scene.get().items.map((item) => item.name)).toEqual(["A", "B", "l"]);
    store.setCode("A=point(0, 0);\n");
    expect(store.scene.get().items.map((item) => item.name)).toEqual(["A"]);
  });

  it("creates a point on click with the point tool", () => {
    const store = makeStore("");
    store.setTool("point");
    store.clickAt(1, 2);
    expect(store.code.get()).toContain("A=point(1, 2);");
    expect(store.scene.get().items.map((item) => item.name)).toEqual(["A"]);
  });

  it("snaps a new point to an existing one", () => {
    const store = makeStore("A=point(1, 2);\n");
    store.setTool("point");
    // Within tolerance (10px at scale 50 => 0.2 world units) of A.
    store.clickAt(1.05, 2.05);
    expect(store.code.get()).toBe("A=point(1, 2);\n");
  });

  it("builds a line with two clicks, creating points as needed", () => {
    const store = makeStore("");
    store.setTool("line");
    store.clickAt(0, 0);
    expect(store.pending.get()).toEqual({ tool: "line", anchor: "A" });
    store.clickAt(3, 1);
    expect(store.pending.get()).toBeNull();
    const code = store.code.get();
    expect(code).toContain("A=point(0, 0);");
    expect(code).toContain("B=point(3, 1);");
    expect(code).toContain("l1=line(A, B);");
    expect(store.scene.get().items.some((item) => item.kind === "line")).toBe(true);
  });

  it("builds a circle with two clicks and reuses existing points", () => {
    const store = makeStore("A=point(0, 0);\nB=point(2, 0);\n");
    store.setTool("circle");
    store.clickAt(0.02, -0.02);
    store.clickAt(1.98, 0.03);
    const code = store.code.get();
    expect(code).toContain("c1=circle(A, B-A);");
    const circle = store.scene.get().items.find((item) => item.kind === "circle");
    expect(circle).toBeDefined();
  });

  it("names an intersection with the intersect tool", () => {
    const store = makeStore(
      ["A=point(-2, 0);", "B=point(2, 0);", "c1=circle(A, B-A);", "c2=circle(B, A-B);", ""].join(
        "\n",
      ),
    );
    store.setTool("intersect");
    // The circles of radius 4 around (-2,0) and (2,0) meet at (0, ±sqrt(12)).
    store.clickAt(0.05, 3.5);
    const code = store.code.get();
    expect(code).toMatch(/C=\(c1\.c2\)\[\d\];/);
    const created = store.evaluation.get().definitions.get("C");
    expect(created).toBeDefined();
  });

  it("snaps a point-tool click to an intersection", () => {
    const store = makeStore(
      [
        "A=point(-2, 0);",
        "B=point(2, 0);",
        "l=line(A, B);",
        "m=line(point(0, -2), point(0, 2));",
        "",
      ].join("\n"),
    );
    store.setTool("point");
    store.clickAt(0.05, 0.05);
    // Both lines pass through the origin; the click snaps to l.m instead of
    // creating a free point. C and D are taken by the inline point() calls
    // having no names — the next free name is C.
    expect(store.code.get()).toContain("C=l.m;");
  });

  it("moves a free point by rewriting its literal coordinates", () => {
    const store = makeStore("A=point(0, 0);\nB=point(2, 0);\nl=line(A, B);\n");
    expect(store.draggablePointAt(0.05, 0.02)).toBe("A");
    store.beginDrag("A");
    store.dragTo("A", -1.5, 2.25);
    expect(store.code.get()).toBe("A=point(-1.5, 2.25);\nB=point(2, 0);\nl=line(A, B);\n");
    // The scene follows the code.
    const a = store.evaluation.get().definitions.get("A");
    expect(a).toBeDefined();
  });

  it("refuses to drag derived points", () => {
    const store = makeStore(["A=point(0, 0);", "B=point(2, 2);", "M=A+0.5*(B-A);", ""].join("\n"));
    expect(store.draggablePointAt(1, 1)).toBeNull();
  });

  it("undoes structured edits", () => {
    const store = makeStore("");
    store.setTool("point");
    store.clickAt(1, 1);
    store.clickAt(2, 2);
    expect(store.scene.get().items).toHaveLength(2);
    store.undo();
    expect(store.scene.get().items).toHaveLength(1);
    store.undo();
    expect(store.scene.get().items).toHaveLength(0);
    expect(store.canUndo.get()).toBe(false);
  });

  it("selecting an item requests the matching editor selection", () => {
    const code = "A=point(0, 0);\nB=point(2, 0);\n";
    const store = makeStore(code);
    store.setTool("select");
    store.clickAt(2.02, 0.02);
    expect(store.selection.get()).toBe("name:B");
    const request = store.editorSelection.get();
    expect(request).not.toBeNull();
    expect(code.slice(request!.start, request!.end)).toBe("B=point(2, 0);");
  });

  it("highlights the object defined by the statement under the caret", () => {
    const code = "A=point(0, 0);\nB=point(2, 0);\n";
    const store = makeStore(code);
    store.cursorOffset.set(code.indexOf("B="));
    expect([...store.highlightedIds.get()]).toContain("name:B");
  });

  it("keeps partial results when the code has an error", () => {
    const store = makeStore("A=point(0, 0);\nB=oops;\n");
    expect(store.evaluation.get().error).not.toBeNull();
    expect(store.scene.get().items.map((item) => item.name)).toEqual(["A"]);
  });

  it("maps between world and screen coordinates", () => {
    const store = makeStore("");
    const screen = store.toScreen(1, 1);
    const world = store.toWorld(screen.x, screen.y);
    expect(world.x).toBeCloseTo(1);
    expect(world.y).toBeCloseTo(1);
    // y axis points up in world coordinates.
    expect(store.toScreen(0, 1).y).toBeLessThan(store.toScreen(0, 0).y);
  });

  it("zooms around the given screen point", () => {
    const store = makeStore("");
    const fixedWorld = store.toWorld(100, 100);
    store.zoomAt(100, 100, 2);
    const after = store.toWorld(100, 100);
    expect(after.x).toBeCloseTo(fixedWorld.x);
    expect(after.y).toBeCloseTo(fixedWorld.y);
    expect(store.viewport.get().scale).toBeCloseTo(100);
  });

  it("zooms by a factor about the middle of the view", () => {
    const store = makeStore("");
    store.viewport.set({ centerX: 3, centerY: -2, scale: 50 });
    store.zoomBy(1.25);
    expect(store.viewport.get().scale).toBeCloseTo(62.5);
    expect(store.viewport.get().centerX).toBeCloseTo(3);
    expect(store.viewport.get().centerY).toBeCloseTo(-2);
  });
});
