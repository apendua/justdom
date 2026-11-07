import assert from "node:assert/strict";
import { test } from "node:test";
import { cut } from "./clip.mjs";

const at = (/** @type {number[]} */ ...times) => times.map((time) => ({ time, data: time }));

test("frames inside a stretch are dropped, and later ones moved back by its length", () => {
  assert.deepEqual(cut(at(0, 1, 2, 3, 4, 5), [[1.5, 3.5]]), [
    { time: 0, data: 0 },
    { time: 1, data: 1 },
    { time: 2, data: 4 },
    { time: 3, data: 5 },
  ]);
});

test("each stretch moves the frames after it back by its own length", () => {
  assert.deepEqual(
    cut(at(0, 2, 4, 6, 8), [
      [1, 3],
      [5, 6],
    ]).map(({ time, data }) => [time, data]),
    [
      [0, 0],
      [2, 4],
      [3, 6],
      [5, 8],
    ],
  );
});

test("with no stretches the frames come back as they were", () => {
  assert.deepEqual(cut(at(0, 1, 2), []), at(0, 1, 2));
});
