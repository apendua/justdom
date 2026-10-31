import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { just, onCleanup, Signal } from "justdom-signal";
import { layoutEffects } from "./operators.js";

/**
 * Records every run of a layout effect, and every teardown of one, in the
 * order they happened.
 *
 * @param {THREE.Object3D} object
 * @param {() => void} [body]
 */
function watch(object, body = () => {}) {
  /** @type {string[]} */
  const log = [];
  const subscription = just(object, [
    layoutEffects(() => {
      log.push("run");
      body();
      onCleanup(() => log.push("cleanup"));
    }),
  ]).subscribe();
  return { log, subscription };
}

describe("layoutEffects", () => {
  test("waits until the object is part of a scene", () => {
    const scene = new THREE.Scene();
    const parent = new THREE.Group();
    const object = new THREE.Object3D();
    parent.add(object);

    const { log } = watch(object);
    assert.deepEqual(log, []);

    scene.add(parent);
    assert.deepEqual(log, ["run"]);
  });

  test("runs straight away for an object already in a scene", () => {
    const scene = new THREE.Scene();
    const object = new THREE.Object3D();
    scene.add(object);

    assert.deepEqual(watch(object).log, ["run"]);
  });

  test("does not run again when an ancestor is picked up and put down", () => {
    // What a grab does: the branch the object hangs off is re-parented onto
    // the hand and later back again, without the object itself ever moving in
    // the room. Nothing a layout effect read has changed, so nothing it built
    // should be torn down and built afresh.
    const scene = new THREE.Scene();
    const board = new THREE.Group();
    const hand = new THREE.Group();
    scene.add(board, hand);
    const object = new THREE.Object3D();
    board.add(object);

    const { log } = watch(object);
    assert.deepEqual(log, ["run"]);

    hand.attach(board);
    scene.attach(board);
    assert.deepEqual(log, ["run"]);
  });

  test("still re-runs when what the effect itself reads changes", () => {
    const scene = new THREE.Scene();
    const object = new THREE.Object3D();
    scene.add(object);
    const value = Signal.of(1);

    const { log } = watch(object, () => {
      value.get();
    });
    assert.deepEqual(log, ["run"]);

    value.set(2);
    assert.deepEqual(log, ["run", "cleanup", "run"]);
  });

  test("cleans up when the object is unmounted", () => {
    const scene = new THREE.Scene();
    const object = new THREE.Object3D();
    scene.add(object);

    const { log, subscription } = watch(object);
    subscription.unsubscribe();
    assert.deepEqual(log, ["run", "cleanup"]);
  });
});
