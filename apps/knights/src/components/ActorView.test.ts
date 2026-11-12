import { describe, expect, it } from "vitest";
import { ATTACKER, DEFENDER, KNIGHT } from "../constants";
import type { FieldCoords } from "../types";
import { ActorViewStore, drawOrder } from "./ActorView";

const dimensions = { fieldWidth: 40, fieldHeight: 30, offsetX: 0, offsetY: 0 };

function stack(row: number, column: number, movePath: FieldCoords[] | null = null) {
  return new ActorViewStore({
    ...dimensions,
    type: KNIGHT,
    side: movePath ? ATTACKER : DEFENDER,
    row,
    column,
    movePath,
  });
}

describe("drawOrder", () => {
  it("draws the stacks far to near", () => {
    const near = stack(4, 1);
    const far = stack(0, 3);
    const middle = stack(2, 0);

    expect(drawOrder([near, far, middle])).toEqual([far, middle, near]);
  });

  it("keeps the order stacks came in when they stand on one row", () => {
    const left = stack(2, 0);
    const right = stack(2, 3);

    expect(drawOrder([right, left])).toEqual([right, left]);
    expect(drawOrder([left, right])).toEqual([left, right]);
  });

  it("moves a walking stack in front of each stack it walks past", () => {
    const walker = stack(0, 1, [
      { row: 0, column: 1 },
      { row: 1, column: 1 },
      { row: 2, column: 1 },
      { row: 3, column: 1 },
      { row: 4, column: 1 },
    ]);
    const passed = stack(2, 2);
    const ahead = stack(4, 2);
    walker.restartMove();

    expect(drawOrder([walker, passed, ahead])).toEqual([walker, passed, ahead]);

    // The walk is only drawn: the stack's own field is still the one it set
    // out from, until the move lands.
    while (walker.position.y <= passed.position.y) {
      walker.tick();
    }
    expect(walker.props.row).toBe(0);
    expect(drawOrder([walker, passed, ahead])).toEqual([passed, walker, ahead]);
  });
});
