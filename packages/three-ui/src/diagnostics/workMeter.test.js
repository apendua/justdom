import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createWorkMeter } from "./workMeter.js";

describe("createWorkMeter", () => {
  test("reads the account's longest pieces at the end of a window, and clears them", () => {
    /** @type {import('./workMeter.js').WorkReading[]} */
    const readings = [];
    const meter = createWorkMeter({ onSample: (reading) => readings.push(reading), sampleMs: 30 });
    const account = { longestDrawMs: 0, longestUploadMs: 0 };

    meter.frame(0, account);
    // The pump raises the account between frames, as it finds longer pieces.
    account.longestDrawMs = 3;
    meter.frame(10, account);
    account.longestUploadMs = 2;
    meter.frame(20, account);
    assert.deepEqual(readings, [], "nothing before the window is over");
    assert.deepEqual(account, { longestDrawMs: 3, longestUploadMs: 2 }, "and nothing cleared");
    meter.frame(30, account);

    assert.deepEqual(readings, [{ drawMs: 3, uploadMs: 2 }]);
    assert.deepEqual(account, { longestDrawMs: 0, longestUploadMs: 0 });
  });

  test("leaves out what the account held before its first frame", () => {
    /** @type {import('./workMeter.js').WorkReading[]} */
    const readings = [];
    const meter = createWorkMeter({ onSample: (reading) => readings.push(reading), sampleMs: 10 });
    const account = { longestDrawMs: 400, longestUploadMs: 90 };

    meter.frame(0, account);
    meter.frame(10, account);

    assert.deepEqual(readings, [{ drawMs: 0, uploadMs: 0 }]);
  });

  test("keeps a long piece for as many windows as it was given, and then lets it go", () => {
    /** @type {import('./workMeter.js').WorkReading[]} */
    const readings = [];
    const meter = createWorkMeter({
      onSample: (reading) => readings.push(reading),
      sampleMs: 10,
      sampleCount: 2,
    });
    const account = { longestDrawMs: 0, longestUploadMs: 0 };

    meter.frame(0, account);
    // A run that took 4 ms to draw in the first window, and nothing after.
    account.longestDrawMs = 4;
    meter.frame(10, account);
    meter.frame(20, account);
    meter.frame(30, account);

    assert.deepEqual(
      readings.map(({ drawMs }) => drawMs),
      [4, 4, 0],
    );
  });
});
