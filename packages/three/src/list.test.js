import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { set, Signal, Subject } from "justdom-signal";
import { list } from "./core.js";
import { $ } from "./operators.js";

/**
 * Mounts a `list` of names whose rows write their index into `obj.name`.
 *
 * @param {Signal<string[]>} items
 * @returns {{ names: () => string[], dispose: () => void }}
 */
function mountIndexed(items) {
  const parent = new THREE.Group();
  /** @type {(() => void) | undefined} */
  let remove;
  const subscription = list(
    () => items.get(),
    (item, getIndex) => $(new THREE.Object3D(), [set("name", () => `${item}@${getIndex()}`)]),
  ).subscribe((component) => {
    remove = component.addTo(parent);
  });
  return {
    names: () => parent.children.map((child) => child.name),
    dispose: () => {
      remove?.();
      subscription.unsubscribe();
    },
  };
}

describe("list()", () => {
  test("gives every row its index, and moves it when the rows move", () => {
    const items = Signal.of(["a", "b", "c"]);
    const mounted = mountIndexed(items);
    assert.deepStrictEqual(mounted.names().sort(), ["a@0", "b@1", "c@2"]);

    items.set(["c", "a", "b"]);
    assert.deepStrictEqual(mounted.names().sort(), ["a@1", "b@2", "c@0"]);
    mounted.dispose();
  });

  test("keeps a row's index subscribed across reorders", () => {
    // The index node reads one stream for its whole life. Built afresh on
    // every run, the stream would be a new dependency each time, and every
    // reorder would drop the old subscription and take out a new one.
    const items = Signal.of(["a", "b", "c"]);
    const subscribe = Subject.prototype.subscribe;
    let subscriptions = 0;
    Subject.prototype.subscribe = function (...args) {
      subscriptions += 1;
      return subscribe.apply(this, args);
    };
    try {
      const mounted = mountIndexed(items);
      const afterMount = subscriptions;
      items.set(["c", "a", "b"]);
      items.set(["b", "c", "a"]);
      assert.strictEqual(subscriptions, afterMount);
      mounted.dispose();
    } finally {
      Subject.prototype.subscribe = subscribe;
    }
  });
});
