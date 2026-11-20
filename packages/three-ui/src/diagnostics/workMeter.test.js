import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createWorkMeter } from "./workMeter.js";

describe("createWorkMeter", () => {
  test("reads the worst frame of each total, not their averages", () => {
    /** @type {import('./workMeter.js').WorkReading[]} */
    const readings = [];
    const meter = createWorkMeter({ onSample: (reading) => readings.push(reading), sampleMs: 30 });

    // Totals as they stand at each frame: one frame drew for 3 ms, another
    // uploaded for 2 ms, and the rest did a little of each.
    meter.frame(0, 10, 5);
    meter.frame(10, 10.5, 5.1);
    meter.frame(20, 13.5, 5.2);
    meter.frame(30, 14, 7.2);

    assert.equal(readings.length, 1);
    assert.ok(Math.abs(readings[0].drawMs - 3) < 1e-9, `drew ${readings[0].drawMs}`);
    assert.ok(Math.abs(readings[0].uploadMs - 2) < 1e-9, `uploaded ${readings[0].uploadMs}`);
  });

  test("leaves out what was spent before its first frame", () => {
    /** @type {import('./workMeter.js').WorkReading[]} */
    const readings = [];
    const meter = createWorkMeter({ onSample: (reading) => readings.push(reading), sampleMs: 10 });

    meter.frame(0, 400, 90);
    meter.frame(10, 400, 90);

    assert.deepEqual(readings, [{ drawMs: 0, uploadMs: 0 }]);
  });

  test("keeps a bad frame for as many windows as it was given, and then lets it go", () => {
    /** @type {import('./workMeter.js').WorkReading[]} */
    const readings = [];
    const meter = createWorkMeter({
      onSample: (reading) => readings.push(reading),
      sampleMs: 10,
      sampleCount: 2,
    });

    meter.frame(0, 0, 0);
    // 4 ms of drawing in the first window, and nothing after it.
    meter.frame(10, 4, 0);
    meter.frame(20, 4, 0);
    meter.frame(30, 4, 0);

    assert.deepEqual(
      readings.map(({ drawMs }) => drawMs),
      [4, 4, 0],
    );
  });
});
