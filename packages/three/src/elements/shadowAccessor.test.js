import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { holdShared, shadowAccessor } from "./shadowAccessor.js";

describe("shadowAccessor", () => {
  test("calls through, and its restore leaves an accessor defined over it since", () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    /** @type {boolean[]} */
    const written = [];
    const restore = shadowAccessor(
      box,
      "checked",
      /**
       * @param {boolean} value
       * @param {(value: boolean) => void} write
       */
      (value, write) => {
        write(value);
        written.push(value);
      },
    );
    assert.ok(restore);
    box.checked = true;
    assert.deepEqual(written, [true]);
    assert.equal(box.checked, true, "the browser's state moved");

    const theirs = { configurable: true, get: () => false, set: () => {} };
    Object.defineProperty(box, "checked", theirs);
    restore();
    assert.equal(Object.getOwnPropertyDescriptor(box, "checked")?.get, theirs.get, "theirs stays");
  });

  test("installs once for every holder, and takes down after the last", () => {
    const element = {};
    let installs = 0;
    let disposals = 0;
    const install = () => {
      installs += 1;
      return () => {
        disposals += 1;
      };
    };
    const first = holdShared(element, "key", install);
    const second = holdShared(element, "key", install);
    first();
    first();
    assert.equal(disposals, 0, "a second release by one holder does nothing");
    second();
    assert.deepEqual([installs, disposals], [1, 1]);
  });
});
