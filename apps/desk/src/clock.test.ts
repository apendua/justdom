import { describe, expect, it } from "vitest";
import { handAngles } from "./clock.js";

describe("handAngles", () => {
  it("points every hand at twelve at noon and midnight", () => {
    expect(handAngles(new Date(2026, 9, 1, 0, 0, 0))).toEqual({ h: 0, m: 0, s: 0 });
    expect(handAngles(new Date(2026, 9, 1, 12, 0, 0))).toEqual({ h: 0, m: 0, s: 0 });
  });

  it("sweeps the hour and minute hands between the marks", () => {
    // Half past three and thirty seconds.
    expect(handAngles(new Date(2026, 9, 1, 15, 30, 30))).toEqual({
      h: 3 * 30 + 30.5 * 0.5,
      m: 30.5 * 6,
      s: 180,
    });
  });
});
