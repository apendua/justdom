import { describe, expect, it } from "vitest";
import { BOARD_AT, BOARD_HEIGHT, EDITOR_AT, editorScale, EDITOR_WIDTH, facing } from "./placement";

/**
 * How high the top edge of a panel `height` metres tall reaches when it
 * hangs at `at`, turned to face the head: half its height above its
 * middle, less what the pitch tips back.
 */
function topOf(at: readonly [number, number, number], height: number): number {
  return at[1] + (height / 2) * Math.cos(facing(at).pitch);
}

describe("the program's panel", () => {
  // The drawing's box, which the toolbar hangs above with a couple of
  // centimetres to spare. The program hangs farther round the viewer and
  // tips back a little less than the drawing, so its top may reach a
  // fraction of a millimetre higher; a millimetre is the tolerance.
  const drawingTop = topOf(BOARD_AT, BOARD_HEIGHT);

  // Editors as tall as a window less the toolbar, from a laptop's to a
  // tall desktop window's, and as wide as the page gives them.
  for (const height of [500, 700, 900, 1037, 1400]) {
    for (const width of [320, 480, 640]) {
      it(`stays under the toolbar when laid out ${width} by ${height} px`, () => {
        const metres = 0.01 * editorScale(width, height);
        expect(topOf(EDITOR_AT, height * metres)).toBeLessThan(drawingTop + 0.001);
        expect(width * metres).toBeLessThanOrEqual(EDITOR_WIDTH + 1e-9);
      });
    }
  }

  it("keeps its full scale in a window short enough for it", () => {
    expect(editorScale(480, 700)).toBe(0.08);
  });
});
