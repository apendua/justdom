import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Derived, just, Signal, Subject, toObservable } from "justdom-signal";
import { $, children } from "./dom.js";
import { text } from "./text.js";

describe("text``", () => {
  it("renders a subscribable interpolation and follows it", () => {
    const label = Signal.of("a");
    const source = toObservable(new Derived(() => label.get()));
    const root = document.createElement("div");
    just(root, [children($("p", [children(text`hello ${source}`)]))]).subscribe();

    assert.equal(root.textContent, "hello a");
    label.set("b");
    assert.equal(root.textContent, "hello b");
  });

  it("waits until every interpolation has said something", () => {
    // What `combineLatest` was here for, and what a derivation says for
    // nothing: a source that has not emitted reads as "not yet", and the
    // effect rendering the template waits rather than rendering half of it.
    /** @type {Subject<string>} */
    const left = new Subject();
    /** @type {Subject<string>} */
    const right = new Subject();
    const root = document.createElement("div");
    just(root, [children($("p", [children(text`${left}-${right}`)]))]).subscribe();

    assert.equal(root.textContent, "");
    left.next("L");
    assert.equal(root.textContent, "");
    right.next("R");
    assert.equal(root.textContent, "L-R");
    left.next("L2");
    assert.equal(root.textContent, "L2-R");
  });

  it("renders a falsy interpolation as nothing at all", () => {
    // Including `0` and `false`, which is what the template has always done.
    const root = document.createElement("div");
    just(root, [
      children($("p", [children(text`[${0}][${null}][${false}][${1}][${"x"}]`)])),
    ]).subscribe();

    assert.equal(root.textContent, "[][][][1][x]");
  });
});
