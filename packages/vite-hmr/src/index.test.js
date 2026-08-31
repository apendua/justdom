import assert from "node:assert/strict";
import test, { beforeEach, describe } from "node:test";
import { component, effectsOnly, just, Stream } from "@apendua/signal";
import { $newReloader, $reloadable } from "./index.js";

/**
 * @import { Source, Subscribable } from "@apendua/signal";
 */

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

/**
 * What the plugin actually emits, and the reason these tests go through a
 * helper rather than calling `$reloadable` directly.
 *
 * The transform splices `$reloadable(name, ctor)` in front of the call or the
 * tagged template that was already there, so what `$reloadable` receives is
 * the *constructor* — `component`, `effectsOnly`, `stylesheet` — and the
 * definition's own arguments arrive on the call after it. Those constructors
 * are generic, and `$reloadable` names its parameter with a concrete
 * `Factory` / `MetaFactory`, so the generated call does not typecheck as
 * written. It never has to: the plugin only runs on `serve`, and its output
 * goes to the browser rather than to `tsc`. The cast is here so the tests can
 * exercise the shape the transform really produces.
 *
 * @param {string} name
 * @param {Function} ctor
 * @returns {(...args: any[]) => any}
 */
function reloadable(name, ctor) {
  return $reloadable(name, /** @type {never} */ (ctor));
}

describe("$reloadable()", () => {
  beforeEach(() => {
    // Each test is a module of its own, so it starts with an empty registry.
    $newReloader();
  });

  test("a source definition follows the module that replaced it", () => {
    // The `stylesheet` shape: the constructor hands back a source rather than
    // a factory, so there is nothing further to wait for.
    const style = reloadable("style", (/** @type {string} */ name) => just(name))("first");

    const { values } = collect(style);
    assert.deepStrictEqual(values, ["first"], "the value it is holding, on subscribe");

    const reload = $newReloader();
    reload({ style: just("second") });
    assert.deepStrictEqual(values, ["first", "second"], "and the one that replaced it");
  });

  test("a factory definition is re-run with the caller's own arguments", () => {
    const Greeting = reloadable(
      "Greeting",
      component,
    )((/** @type {string} */ who) => just(`hello ${who}`));

    const { values } = collect(Greeting("world"));
    assert.deepStrictEqual(values, ["hello world"]);

    // What the new module exports is its own `$reloadable` wrapper, not the
    // bare factory — which is what a reload actually hands over.
    const reload = $newReloader();
    reload({
      Greeting: reloadable(
        "Greeting",
        component,
      )((/** @type {string} */ who) => just(`goodbye ${who}`)),
    });
    assert.deepStrictEqual(
      values,
      ["hello world", "goodbye world"],
      "the arguments the caller passed survive the swap",
    );
  });

  test("the previous definition is unsubscribed before the next is taken", () => {
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

    const Behaviour = reloadable("Behaviour", component)(() => tracked("first"));
    const { subscription } = collect(Behaviour());

    const reload = $newReloader();
    reload({ Behaviour: reloadable("Behaviour", component)(() => tracked("second")) });
    assert.deepStrictEqual(
      order,
      ["up:first", "down:first", "up:second"],
      "the order `switchMap` ran them in",
    );

    subscription.unsubscribe();
    assert.deepStrictEqual(order, ["up:first", "down:first", "up:second", "down:second"]);
  });

  test("a definition nothing subscribed to costs nothing on reload", () => {
    let runs = 0;
    const Behaviour = reloadable(
      "Behaviour",
      effectsOnly,
    )(() => {
      runs += 1;
    });
    Behaviour();

    const reload = $newReloader();
    reload({
      Behaviour: reloadable(
        "Behaviour",
        effectsOnly,
      )(() => {
        runs += 1;
      }),
    });
    assert.strictEqual(runs, 0, "a factory is not run until something subscribes");
  });

  test("a name nothing registered is left alone", () => {
    const reload = $newReloader();
    assert.doesNotThrow(() => reload({ somethingElse: just("x") }));
  });
});
