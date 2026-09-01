import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  component,
  Derived,
  Effect,
  effectsOnly,
  just,
  observable,
  Signal,
  Stream,
} from "@apendua/signal";
import { $hmr } from "./index.js";

/**
 * @import { Source, Subscribable } from "@apendua/signal";
 * @import { HotContext } from "./index.js";
 */

/**
 * A stand-in for `import.meta.hot`: the one part of it the runtime uses is
 * the `data` object Vite keeps across every version of a module.
 *
 * @returns {HotContext}
 */
function fakeHot() {
  return { data: {} };
}

/**
 * Everything a source has said so far, and the handle to stop listening.
 *
 * @template T
 * @param {Subscribable<T>} source
 */
function collect(source) {
  /** @type {T[]} */
  const values = [];
  const subscription = source.subscribe({
    next: (value) => {
      values.push(value);
    },
  });
  return { values, subscription };
}

describe("a function export", () => {
  test("re-runs the computation that called it, with the new definition", () => {
    const hot = fakeHot();
    const double = $hmr(hot).reloadable("double", (/** @type {number} */ n) => n * 2);

    /** @type {number[]} */
    const seen = [];
    const effect = new Effect(() => {
      seen.push(double(21));
    });
    assert.deepStrictEqual(seen, [42]);

    const again = $hmr(hot).reloadable("double", (/** @type {number} */ n) => n * 3);
    assert.strictEqual(again, double, "the module exports the same wrapper every time");
    assert.deepStrictEqual(seen, [42, 63], "the reload was a write the effect depends on");
    effect.dispose();
  });

  test("outside a computation it simply calls the current definition", () => {
    const hot = fakeHot();
    const greet = $hmr(hot).reloadable("greet", (/** @type {string} */ who) => `hello ${who}`);
    assert.strictEqual(greet("world"), "hello world");
    $hmr(hot).reloadable("greet", (/** @type {string} */ who) => `goodbye ${who}`);
    assert.strictEqual(greet("world"), "goodbye world");
  });

  test("passes `this`, the arguments and `new` through", () => {
    const hot = fakeHot();
    function Point(/** @type {number} */ x, /** @type {number} */ y) {
      // @ts-expect-error — an old-style constructor, for `new` to have something to construct.
      this.x = x;
      // @ts-expect-error
      this.y = y;
    }
    const Reloadable = /** @type {any} */ ($hmr(hot).reloadable("Point", Point));
    const point = new Reloadable(1, 2);
    assert.deepStrictEqual({ x: point.x, y: point.y }, { x: 1, y: 2 });
    assert.strictEqual(Reloadable.name, "Point");
    assert.strictEqual(Reloadable.length, 2);

    const method = $hmr(hot).reloadable("method", function () {
      // @ts-expect-error — `this` is whatever the call supplied.
      return this.tag;
    });
    assert.strictEqual(method.call({ tag: "bound" }), "bound");
  });

  test("a dependent node is a dependent of the module, and takes the cutoff", () => {
    const hot = fakeHot();
    const answer = $hmr(hot).reloadable("answer", () => 42);
    const doubled = new Derived(() => answer() * 2);
    let evaluations = 0;
    const effect = new Effect(() => {
      doubled.get();
      evaluations += 1;
    });
    assert.strictEqual(evaluations, 1);

    // The same answer from different code: the derived recomputes, the effect
    // does not.
    $hmr(hot).reloadable("answer", () => 40 + 2);
    assert.strictEqual(doubled.getEvaluations(), 2);
    assert.strictEqual(evaluations, 1, "an unchanged value stops at the `Derived`");

    $hmr(hot).reloadable("answer", () => 43);
    assert.strictEqual(evaluations, 2);
    effect.dispose();
  });
});

describe("a factory export", () => {
  test("switches the mounted instance without re-running whoever mounted it", () => {
    const hot = fakeHot();
    const Greeting = $hmr(hot).reloadable(
      "Greeting",
      component((/** @type {string} */ who) => just(`hello ${who}`)),
    );

    let mounts = 0;
    // The parent: a computation that calls the factory, the way one component
    // mounts another.
    const parent = observable(() => {
      mounts += 1;
      return Greeting("world");
    });
    /** @type {string[]} */
    const values = [];
    const subscription = parent.subscribe((source) => {
      source.subscribe((value) => values.push(value));
    });
    assert.deepStrictEqual(values, ["hello world"]);
    assert.strictEqual(mounts, 1);

    $hmr(hot).reloadable(
      "Greeting",
      component((/** @type {string} */ who) => just(`goodbye ${who}`)),
    );
    assert.deepStrictEqual(
      values,
      ["hello world", "goodbye world"],
      "the caller's arguments survive",
    );
    assert.strictEqual(mounts, 1, "the parent was not touched");
    subscription.unsubscribe();
  });

  test("the previous definition is unsubscribed before the next is taken", () => {
    const hot = fakeHot();
    /** @type {string[]} */
    const order = [];
    /**
     * @param {string} label
     * @returns {Source<string>}
     */
    const tracked = (label) =>
      new Stream((subscriber) => {
        order.push(`up:${label}`);
        subscriber.next(label);
        return () => {
          order.push(`down:${label}`);
        };
      });

    const Behaviour = $hmr(hot).reloadable(
      "Behaviour",
      component(() => tracked("first")),
    );
    const { subscription } = collect(Behaviour());

    $hmr(hot).reloadable(
      "Behaviour",
      component(() => tracked("second")),
    );
    assert.deepStrictEqual(order, ["up:first", "down:first", "up:second"]);

    subscription.unsubscribe();
    assert.deepStrictEqual(order, ["up:first", "down:first", "up:second", "down:second"]);
  });

  test("a definition nothing subscribed to costs nothing on reload", () => {
    const hot = fakeHot();
    let runs = 0;
    const Behaviour = $hmr(hot).reloadable(
      "Behaviour",
      effectsOnly(() => {
        runs += 1;
      }),
    );
    Behaviour();
    $hmr(hot).reloadable(
      "Behaviour",
      effectsOnly(() => {
        runs += 1;
      }),
    );
    assert.strictEqual(runs, 0, "a factory is not run until something subscribes");
  });

  test("a source built before the reload is mounted as it is, not rebuilt", () => {
    const hot = fakeHot();
    let built = 0;
    const Thing = $hmr(hot).reloadable("Thing", () => {
      built += 1;
      return just("one");
    });
    const source = Thing();
    assert.strictEqual(built, 1);
    const { values } = collect(source);
    assert.deepStrictEqual(values, ["one"]);
    assert.strictEqual(built, 1, "the call's own result was what got mounted");
  });
});

describe("a source export", () => {
  test("follows the module that replaced it", () => {
    // The `stylesheet` shape: what the module defines is a `Stream`, already
    // built, with nothing further to wait for.
    const hot = fakeHot();
    const style = $hmr(hot).reloadable("style", just("first"));
    const { values } = collect(style);
    assert.deepStrictEqual(values, ["first"], "the value it is holding, on subscribe");

    $hmr(hot).reloadable("style", just("second"));
    assert.deepStrictEqual(values, ["first", "second"], "and the one that replaced it");
  });
});

describe("a derived export", () => {
  test("is a node whose dependents follow the module", () => {
    const hot = fakeHot();
    const input = Signal.of(2);
    const squared = $hmr(hot).reloadable("squared", new Derived(() => input.get() ** 2));
    assert.ok(squared instanceof Derived);

    /** @type {number[]} */
    const seen = [];
    const effect = new Effect(() => {
      seen.push(squared.get());
    });
    input.set(3);
    assert.deepStrictEqual(seen, [4, 9]);

    $hmr(hot).reloadable("squared", new Derived(() => input.get() ** 3));
    assert.deepStrictEqual(seen, [4, 9, 27], "the new node, read by the old dependents");
    input.set(2);
    assert.deepStrictEqual(seen, [4, 9, 27, 8], "and its inputs still move it");
    effect.dispose();
  });
});

describe("invalidation", () => {
  test("an update whose every export was followed is taken in place", () => {
    const hot = fakeHot();
    $hmr(hot).reloadable("fn", () => 1);
    $hmr(hot).reloadable("style", just("a"));
    $hmr(hot).reloadable("LIMIT", 10);
    const next = $hmr(hot);
    const fn = next.reloadable("fn", () => 2);
    const style = next.reloadable("style", just("b"));
    const LIMIT = next.reloadable("LIMIT", 10);
    assert.strictEqual(next.invalidation({ fn, style, LIMIT }), null);
  });

  test("a wrapper re-exported under another name is the same thing", () => {
    const hot = fakeHot();
    const first = $hmr(hot);
    const Board = first.reloadable("Board", () => "board");
    assert.strictEqual(first.reloadable("default", Board), Board);
    const next = $hmr(hot);
    const again = next.reloadable("Board", () => "board!");
    assert.strictEqual(next.reloadable("default", again), Board);
    assert.strictEqual(next.invalidation({ Board, default: Board }), null);
  });

  test("a value that changed cannot be taken in place", () => {
    const hot = fakeHot();
    $hmr(hot).reloadable("LIMIT", 10);
    const next = $hmr(hot);
    next.reloadable("LIMIT", 20);
    assert.match(String(next.invalidation({ LIMIT: 20 })), /LIMIT cannot be replaced/);
  });

  test("an object is a different value every evaluation", () => {
    const hot = fakeHot();
    $hmr(hot).reloadable("palette", { red: "#f00" });
    const next = $hmr(hot);
    next.reloadable("palette", { red: "#f00" });
    assert.match(String(next.invalidation({ palette: {} })), /palette cannot be replaced/);
  });

  test("a class is left alone rather than wrapped", () => {
    const hot = fakeHot();
    class Thing {}
    assert.strictEqual($hmr(hot).reloadable("Thing", Thing), Thing);
    const next = $hmr(hot);
    class Thing2 {}
    next.reloadable("Thing", Thing2);
    assert.match(String(next.invalidation({ Thing: Thing2 })), /Thing cannot be replaced/);
  });

  test("a definition that changed kind cannot be taken in place", () => {
    const hot = fakeHot();
    $hmr(hot).reloadable("thing", () => 1);
    const next = $hmr(hot);
    next.reloadable("thing", just(1));
    assert.match(String(next.invalidation({ thing: null })), /thing cannot be replaced/);
    // The evaluation the invalidation provokes finds the entry current again.
    const after = $hmr(hot);
    after.reloadable("thing", just(2));
    assert.strictEqual(after.invalidation({ thing: null }), null);
  });

  test("an export nothing registered, and one that went missing", () => {
    const hot = fakeHot();
    $hmr(hot).reloadable("a", () => 1);
    $hmr(hot).reloadable("b", () => 2);
    let next = $hmr(hot);
    next.reloadable("a", () => 1);
    next.reloadable("b", () => 2);
    assert.match(String(next.invalidation({ a: 1, b: 2, c: 3 })), /c is not a reloadable export/);
    next = $hmr(hot);
    next.reloadable("a", () => 1);
    assert.match(String(next.invalidation({ a: 1 })), /b is no longer exported/);
  });

  test("the previous module's reloader answers for the latest evaluation", () => {
    const hot = fakeHot();
    const previous = $hmr(hot);
    previous.reloadable("LIMIT", 10);
    const latest = $hmr(hot);
    latest.reloadable("LIMIT", 11);
    // The update reaches the *previous* module's accept callback, which holds
    // the previous reloader.
    assert.match(String(previous.invalidation({ LIMIT: 11 })), /LIMIT cannot be replaced/);
  });

  test("without a hot context every evaluation stands on its own", () => {
    const fn = $hmr(undefined).reloadable("fn", () => 1);
    const again = $hmr(undefined).reloadable("fn", () => 2);
    assert.notStrictEqual(fn, again);
    assert.strictEqual(fn(), 1);
    assert.strictEqual(again(), 2);
  });
});
