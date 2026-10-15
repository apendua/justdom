import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { checkSampleRate, createNoise, createSweepWaveform, normalize } from "./waveform.js";

describe("checkSampleRate", () => {
  test("refuses a rate that is not a positive number", () => {
    assert.throws(() => checkSampleRate(0), /positive number/);
    assert.throws(() => checkSampleRate(-48000), /positive number/);
    assert.throws(() => checkSampleRate(Number.NaN), /positive number/);
    assert.doesNotThrow(() => checkSampleRate(48000));
  });
});

describe("createNoise", () => {
  test("is the same grain every time", () => {
    const a = createNoise();
    const b = createNoise();
    for (let i = 0; i < 1000; i += 1) {
      assert.equal(a(), b());
    }
  });

  test("stays within [-1, 1) and is not stuck", () => {
    const noise = createNoise();
    let low = 0;
    let high = 0;
    for (let i = 0; i < 10000; i += 1) {
      const value = noise();
      assert.ok(value >= -1 && value < 1);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    assert.ok(low < -0.9 && high > 0.9);
  });
});

describe("normalize", () => {
  test("scales the loudest sample to exactly one, whichever its sign", () => {
    const samples = normalize(new Float32Array([0.1, -0.4, 0.2]));
    assert.deepEqual([...samples], [...new Float32Array([0.25, -1, 0.5])]);
  });

  test("leaves silence as it is", () => {
    assert.deepEqual([...normalize(new Float32Array(3))], [0, 0, 0]);
  });
});

describe("createSweepWaveform", () => {
  const sweep = { from: 400, to: 100, duration: 0.2, decay: 10, edge: 0.3, noise: 0.2 };

  test("lasts as long as it is asked to, whatever the rate", () => {
    assert.equal(createSweepWaveform(48000, sweep).length, 9600);
    assert.equal(createSweepWaveform(44100, sweep).length, 8820);
  });

  test("refuses a rate that is not a positive number", () => {
    assert.throws(() => createSweepWaveform(0, sweep), /positive number/);
  });

  test("starts and ends at silence, and peaks at exactly one", () => {
    const samples = createSweepWaveform(48000, sweep);
    assert.equal(samples[0], 0);
    assert.ok(Math.abs(samples[samples.length - 1]) < 0.01);
    let peak = 0;
    for (const sample of samples) {
      peak = Math.max(peak, Math.abs(sample));
    }
    assert.equal(peak, 1);
  });

  test("slides: it crosses zero more often at the start than at the end", () => {
    const samples = createSweepWaveform(48000, { ...sweep, noise: 0 });
    /** @param {number} from @param {number} to */
    const crossings = (from, to) => {
      let count = 0;
      for (let i = from + 1; i < to; i += 1) {
        if (Math.sign(samples[i]) !== Math.sign(samples[i - 1])) {
          count += 1;
        }
      }
      return count;
    };
    const tenth = samples.length / 10;
    assert.ok(crossings(0, tenth) > 2 * crossings(9 * tenth, samples.length));
  });
});
