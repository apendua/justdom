import { describe, expect, it } from "vitest";
import Studio from "./Studio";

function makeStudio(code: string): Studio {
  const studio = new Studio(1.2, 0.9);
  studio.code.set(code);
  // 0.1 m per world unit: the 2 cm hit tolerance is 0.2 world units.
  studio.viewport.set({ centerX: 0, centerY: 0, scale: 0.1 });
  return studio;
}

describe("Studio", () => {
  it("maps between board meters and world coordinates", () => {
    const studio = makeStudio("");
    const board = studio.toBoard(3, -2);
    expect(board.x).toBeCloseTo(0.3, 12);
    expect(board.y).toBeCloseTo(-0.2, 12);
    const world = studio.toWorld(board.x, board.y);
    expect(world.x).toBeCloseTo(3, 12);
    expect(world.y).toBeCloseTo(-2, 12);
  });

  it("shows the world rectangle the board covers", () => {
    const studio = makeStudio("");
    const rect = studio.visibleRect();
    expect(rect.maxX - rect.minX).toBeCloseTo(12);
    expect(rect.maxY - rect.minY).toBeCloseTo(9);
  });

  it("places a point with the point tool", () => {
    const studio = makeStudio("");
    studio.setTool("point");
    studio.clickAt(1, 2);
    expect(studio.code.get()).toContain("A=point(1, 2);");
  });

  it("snaps to an existing point within tolerance", () => {
    const studio = makeStudio("A=point(1, 2);\n");
    studio.setTool("point");
    studio.clickAt(1.1, 2.1);
    expect(studio.code.get()).toBe("A=point(1, 2);\n");
  });

  it("builds a line with two trigger clicks", () => {
    const studio = makeStudio("");
    studio.setTool("line");
    studio.clickAt(0, 0);
    expect(studio.pending.get()).toEqual({ tool: "line", anchor: "A" });
    studio.clickAt(3, 1);
    const code = studio.code.get();
    expect(code).toContain("l1=line(A, B);");
    expect(studio.pending.get()).toBeNull();
  });

  it("builds a circle from center and rim points", () => {
    const studio = makeStudio("A=point(0, 0);\nB=point(2, 0);\n");
    studio.setTool("circle");
    studio.clickAt(0.05, 0);
    studio.clickAt(1.95, 0.05);
    expect(studio.code.get()).toContain("c1=circle(A, B-A);");
  });

  it("names intersections", () => {
    const studio = makeStudio(
      ["A=point(-2, 0);", "B=point(2, 0);", "c1=circle(A, B-A);", "c2=circle(B, A-B);", ""].join(
        "\n",
      ),
    );
    studio.setTool("intersect");
    studio.clickAt(0.05, 3.45);
    expect(studio.code.get()).toMatch(/C=\(c1\.c2\)\[\d\];/);
  });

  it("drags free points by rewriting their literals", () => {
    const studio = makeStudio("A=point(0, 0);\nB=point(2, 0);\nl=line(A, B);\n");
    expect(studio.draggablePointAt(0.05, 0)).toBe("A");
    studio.beginDrag("A");
    studio.dragTo("A", -1.5, 2.25);
    expect(studio.code.get()).toBe("A=point(-1.5, 2.25);\nB=point(2, 0);\nl=line(A, B);\n");
    studio.undo();
    expect(studio.code.get()).toBe("A=point(0, 0);\nB=point(2, 0);\nl=line(A, B);\n");
  });

  it("selects items and exposes the snap target", () => {
    const studio = makeStudio("A=point(0, 0);\nB=point(2, 0);\nl=line(A, B);\n");
    studio.setTool("select");
    studio.clickAt(2.02, 0.02);
    expect(studio.selection.get()).toBe("name:B");
    studio.setTool("point");
    studio.cursor.set({ x: 1.98, y: 0.03 });
    const snap = studio.snapTarget();
    expect(snap).not.toBeNull();
    expect(snap!.x).toBeCloseTo(2);
  });

  it("pans by board deltas and fits the drawing", () => {
    const studio = makeStudio("A=point(0, 0);\nB=point(4, 0);\nc1=circle(A, B-A);\n");
    studio.panByBoardDelta(0.1, 0);
    expect(studio.viewport.get().centerX).toBeCloseTo(-1);
    studio.fitView();
    const viewport = studio.viewport.get();
    expect(viewport.centerX).toBeCloseTo(0);
    // The circle spans 8 world units; 80% of the 0.9 m board height limits it.
    expect(viewport.scale).toBeCloseTo((0.9 / 8) * 0.8);
  });
});
