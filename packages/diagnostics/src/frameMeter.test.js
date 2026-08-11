import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chartCeiling, createFrameMeter } from "./frameMeter.js";

/**
 * Draws frames at a steady rate, the way a display that is keeping up would.
 *
 * @param {import('./frameMeter.js').FrameMeter} meter
 * @param {number} fps
 * @param {number} ms How long to keep it up for.
 * @param {number} [from] The timestamp to start at.
 * @returns {number} The timestamp of the last frame drawn.
 */
function run(meter, fps, ms, from = 0) {
  const step = 1000 / fps;
  let time = from;
  const until = from + ms;
  meter.frame(time);
  while (time + step <= until) {
    time += step;
    meter.frame(time);
  }
  return time;
}

describe("createFrameMeter", () => {
  test("reads the rate the frames actually arrived at", () => {
    /** @type {number[]} */
    const readouts = [];
    const meter = createFrameMeter({ onReadout: (fps) => readouts.push(fps) });

    run(meter, 90, 2000);

    assert.ok(readouts.length >= 3, "half-second readings over two seconds");
    for (const fps of readouts) {
      assert.ok(Math.abs(fps - 90) < 1, `expected about 90, got ${fps}`);
    }
  });

  test("says nothing on the first frame, having nothing to divide by yet", () => {
    /** @type {number[]} */
    const readouts = [];
    const meter = createFrameMeter({ onReadout: (fps) => readouts.push(fps) });

    meter.frame(1000);

    assert.deepEqual(readouts, []);
  });

  test("the chart keeps the last minute and drops what falls off the back", () => {
    /** @type {number[]} */
    let latest = [];
    const meter = createFrameMeter({
      sampleCount: 3,
      sampleMs: 1000,
      onSample: (history) => {
        latest = [...history];
      },
    });

    // Four seconds of it, into a chart three bars wide.
    run(meter, 60, 4000);

    assert.equal(latest.length, 3, "the oldest bar is dropped rather than the newest refused");
    for (const fps of latest) {
      assert.ok(Math.abs(fps - 60) < 1, `expected about 60, got ${fps}`);
    }
  });

  test("a session that stops being drawn reports the frames it got, not the ones the clock says", () => {
    /** @type {number[]} */
    const readouts = [];
    const meter = createFrameMeter({ onReadout: (fps) => readouts.push(fps) });

    // One frame, then five seconds of nothing — the headset put down — then
    // the frame that comes back.
    meter.frame(0);
    meter.frame(5000);

    assert.equal(readouts.length, 1);
    assert.ok(
      readouts[0] < 1,
      `a five second gap is well under one frame a second: ${readouts[0]}`,
    );
  });

  test("counts against the frame timestamps rather than against wall time", () => {
    /** @type {number[]} */
    const readouts = [];
    const meter = createFrameMeter({ onReadout: (fps) => readouts.push(fps) });

    // A session whose clock starts at some arbitrary point, which is what a
    // frame callback's timestamp is.
    run(meter, 72, 1000, 123456.789);

    assert.ok(readouts.length >= 1);
    assert.ok(Math.abs(readouts[0] - 72) < 1, `expected about 72, got ${readouts[0]}`);
  });
});

describe("chartCeiling", () => {
  test("snaps a reading to the rate the display is evidently running at", () => {
    assert.equal(chartCeiling(0), 60);
    assert.equal(chartCeiling(59.4), 60);
    assert.equal(chartCeiling(71.6), 72);
    assert.equal(chartCeiling(89.8), 90);
    assert.equal(chartCeiling(119.2), 120);
  });

  test("a reading just over a known rate is that rate, not the next one up", () => {
    // Averages land a little either side of the truth; a 72 Hz headset must
    // not spend the session being charted against 80.
    assert.equal(chartCeiling(72.4), 72);
    assert.equal(chartCeiling(90.6), 90);
  });

  test("something past the known rates is rounded rather than pinned", () => {
    assert.equal(chartCeiling(240), 240);
    assert.equal(chartCeiling(163), 170);
  });
});
