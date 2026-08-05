import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createClickWaveform } from "./click.js";

/** Root mean square of a slice, which is what "how loud is this bit" means. */
function level(samples: Float32Array, from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i += 1) {
    total += samples[i] * samples[i];
  }
  return Math.sqrt(total / (to - from));
}

describe("createClickWaveform", () => {
  test("is fifty milliseconds long, whatever the rate", () => {
    assert.equal(createClickWaveform(48000).length, 2400);
    assert.equal(createClickWaveform(44100).length, 2205);
  });

  test("refuses a rate that is not a positive number", () => {
    assert.throws(() => createClickWaveform(0), /positive number/);
    assert.throws(() => createClickWaveform(-48000), /positive number/);
    assert.throws(() => createClickWaveform(Number.NaN), /positive number/);
  });

  test("starts and ends at silence, so it cannot pop", () => {
    const samples = createClickWaveform(48000);
    assert.equal(samples[0], 0);
    assert.ok(Math.abs(samples[samples.length - 1]) < 0.01);
  });

  test("uses the whole range and no more", () => {
    const samples = createClickWaveform(48000);
    let peak = 0;
    for (const sample of samples) {
      peak = Math.max(peak, Math.abs(sample));
    }
    assert.ok(peak <= 1);
    assert.ok(peak > 0.999);
  });

  test("is a knock: it only ever gets quieter, and dies away to nothing", () => {
    const samples = createClickWaveform(48000);
    // Five milliseconds at 48 kHz, which is long enough to average the ringing
    // out and short enough that ten of them cover the whole click.
    const window = 240;
    let previous = Number.POSITIVE_INFINITY;
    for (let start = 0; start + window <= samples.length; start += window) {
      const now = level(samples, start, start + window);
      assert.ok(now < previous, `${start / 48} ms in, the click got louder again`);
      previous = now;
    }
    assert.ok(previous < 0.01, `the click was still audible at the end: ${previous}`);
  });

  test("makes the same sound every time", () => {
    assert.deepEqual(createClickWaveform(48000), createClickWaveform(48000));
  });
});
