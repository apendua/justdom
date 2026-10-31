import assert from "node:assert/strict";
import test, { afterEach, describe } from "node:test";
import { audioOutputs, audioOutputSelection, setAudioOutput } from "./audioOutputs.js";

/**
 * @import { Source, Unsubscribable } from 'justdom-signal';
 * @import { AudioOutput } from './audioOutputs.js';
 */

/**
 * Node has neither `navigator.mediaDevices` nor `AudioContext`, which is also
 * the shape of a browser that cannot route audio — so both are installed per
 * test, and the absence of either is a case worth testing on its own.
 *
 * @typedef {EventTarget & {
 *   enumerateDevices: () => Promise<MediaDeviceInfo[]>,
 *   calls: number,
 * }} FakeMediaDevices
 */

/**
 * @param {Partial<MediaDeviceInfo>[]} devices
 * @returns {FakeMediaDevices}
 */
function fakeMediaDevices(devices) {
  const target = /** @type {FakeMediaDevices} */ (new EventTarget());
  target.calls = 0;
  target.enumerateDevices = async () => {
    target.calls += 1;
    return /** @type {MediaDeviceInfo[]} */ (devices);
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: target },
  });
  return target;
}

/**
 * @param {boolean} routable whether the platform's audio can be pointed at a
 *   device of our choosing, i.e. whether `AudioContext` has `setSinkId`
 * @returns {string[]} the sink ids it was pointed at, in order
 */
function fakeAudioContext(routable) {
  /** @type {string[]} */
  const sinkIds = [];
  class FakeAudioContext {}
  if (routable) {
    Object.defineProperty(FakeAudioContext.prototype, "setSinkId", {
      configurable: true,
      value: /** @param {string} sinkId */ async (sinkId) => {
        sinkIds.push(sinkId);
      },
    });
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  return sinkIds;
}

function restoreGlobals() {
  Reflect.deleteProperty(globalThis, "AudioContext");
  Reflect.deleteProperty(globalThis, "navigator");
}

/**
 * @param {Source<AudioOutput[]>} source
 * @returns {{ values: AudioOutput[][], subscription: Unsubscribable }}
 */
function collect(source) {
  /** @type {AudioOutput[][]} */
  const values = [];
  const subscription = source.subscribe((value) => {
    values.push(value);
  });
  return { values, subscription };
}

/**
 * Lets the promise chain inside `enumerateDevices` settle.
 *
 * @returns {Promise<void>}
 */
function flush() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("audioOutputs", () => {
  afterEach(restoreGlobals);

  test("stays empty where audio cannot be routed at all", async () => {
    fakeAudioContext(false);
    const mediaDevices = fakeMediaDevices([
      { kind: "audiooutput", deviceId: "a", groupId: "1", label: "Speakers" },
      { kind: "audiooutput", deviceId: "b", groupId: "2", label: "Headphones" },
    ]);

    const { values, subscription } = collect(audioOutputs());
    await flush();
    subscription.unsubscribe();

    assert.deepEqual(values, [[]]);
    assert.equal(mediaDevices.calls, 0);
  });

  test("reports one entry per physical output, under its own name", async () => {
    fakeAudioContext(true);
    fakeMediaDevices([
      { kind: "audioinput", deviceId: "mic", groupId: "0", label: "Microphone" },
      { kind: "audiooutput", deviceId: "default", groupId: "1", label: "Default - Speakers" },
      { kind: "audiooutput", deviceId: "communications", groupId: "1", label: "Speakers" },
      { kind: "audiooutput", deviceId: "a", groupId: "1", label: "Speakers" },
      { kind: "audiooutput", deviceId: "b", groupId: "2", label: "Headphones" },
    ]);

    const { values, subscription } = collect(audioOutputs());
    await flush();
    subscription.unsubscribe();

    assert.deepEqual(values, [
      [],
      [
        { deviceId: "a", label: "Speakers" },
        { deviceId: "b", label: "Headphones" },
      ],
    ]);
  });

  test("names outputs the browser refuses to name", async () => {
    fakeAudioContext(true);
    fakeMediaDevices([
      { kind: "audiooutput", deviceId: "default", groupId: "", label: "" },
      { kind: "audiooutput", deviceId: "b", groupId: "2", label: "" },
    ]);

    const { values, subscription } = collect(audioOutputs());
    await flush();
    subscription.unsubscribe();

    assert.deepEqual(values[1], [
      { deviceId: "default", label: "System default" },
      { deviceId: "b", label: "Output 2" },
    ]);
  });

  test("follows devices being plugged in and pulled out", async () => {
    fakeAudioContext(true);
    /** @type {Partial<MediaDeviceInfo>[]} */
    const devices = [{ kind: "audiooutput", deviceId: "a", groupId: "1", label: "Speakers" }];
    const mediaDevices = fakeMediaDevices(devices);

    const { values, subscription } = collect(audioOutputs());
    await flush();
    devices.push({ kind: "audiooutput", deviceId: "b", groupId: "2", label: "Headphones" });
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await flush();

    assert.equal(values.length, 3);
    assert.deepEqual(values[2], [
      { deviceId: "a", label: "Speakers" },
      { deviceId: "b", label: "Headphones" },
    ]);

    // A list that came back unchanged is not worth passing on.
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await flush();
    assert.equal(values.length, 3);

    subscription.unsubscribe();
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await flush();
    assert.equal(mediaDevices.calls, 3);
  });
});

describe("setAudioOutput", () => {
  afterEach(restoreGlobals);

  test("points the context at the chosen device", async () => {
    const sinkIds = fakeAudioContext(true);
    const context = new AudioContext();

    assert.equal(await setAudioOutput(context, "b"), true);
    assert.deepEqual(sinkIds, ["b"]);
  });

  test("reports failure instead of throwing where routing is unsupported", async () => {
    fakeAudioContext(false);
    const context = new AudioContext();

    assert.equal(await setAudioOutput(context, "b"), false);
  });

  test("reports failure when the device is gone by the time it is chosen", async () => {
    fakeAudioContext(true);
    const context = new AudioContext();
    Object.defineProperty(context, "setSinkId", {
      configurable: true,
      value: async () => {
        throw new Error("device not found");
      },
    });

    assert.equal(await setAudioOutput(context, "gone"), false);
  });
});

describe("audioOutputSelection", () => {
  afterEach(restoreGlobals);

  test("sends the sound to a chosen output, and refuses anything else", async () => {
    fakeAudioContext(true);
    fakeMediaDevices([
      { kind: "audiooutput", deviceId: "a", groupId: "1", label: "Speakers" },
      { kind: "audiooutput", deviceId: "b", groupId: "2", label: "Headphones" },
    ]);

    const selection = audioOutputSelection();
    const subscription = selection.updates.subscribe();
    await flush();

    assert.equal(selection.deviceId.get(), "");

    selection.select("b");
    assert.equal(selection.deviceId.get(), "b");

    selection.select("a");
    assert.equal(selection.deviceId.get(), "a");

    // A device that went away between the menu opening and a row being pressed.
    selection.select("gone");
    assert.equal(selection.deviceId.get(), "a");

    subscription.unsubscribe();
  });

  test("hands the choice back once the chosen output is unplugged", async () => {
    fakeAudioContext(true);
    /** @type {Partial<MediaDeviceInfo>[]} */
    const devices = [
      { kind: "audiooutput", deviceId: "a", groupId: "1", label: "Speakers" },
      { kind: "audiooutput", deviceId: "b", groupId: "2", label: "Headphones" },
    ];
    const mediaDevices = fakeMediaDevices(devices);

    const selection = audioOutputSelection();
    const subscription = selection.updates.subscribe();
    await flush();
    selection.select("b");
    assert.equal(selection.deviceId.get(), "b");

    devices.pop();
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await flush();

    assert.equal(selection.deviceId.get(), "");
    assert.deepEqual(selection.outputs.get(), [{ deviceId: "a", label: "Speakers" }]);

    subscription.unsubscribe();
  });

  test("does nothing while there is nothing to choose from", async () => {
    fakeAudioContext(false);
    fakeMediaDevices([]);

    const selection = audioOutputSelection();
    const subscription = selection.updates.subscribe();
    await flush();

    selection.select("a");
    assert.equal(selection.deviceId.get(), "");
    assert.deepEqual(selection.outputs.get(), []);

    subscription.unsubscribe();
  });
});
