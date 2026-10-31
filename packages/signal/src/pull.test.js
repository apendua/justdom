import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { map, ReplaySubject, shareReplay } from "rxjs";
import { rx } from "./rxjs.js";

import {
  Signal,
  Derived,
  Effect,
  toObservable,
  fromObservable,
  observable,
  valueOf,
} from "./index.js";

/**
 * A chain of `depth` derived nodes over one signal, all carrying the same
 * value. Anything computed from two points on the chain is a constant, so a
 * reader that ever sees a non-constant has been given a half-updated view.
 *
 * @param {Signal<number>} source
 * @param {number} depth
 * @returns {Derived<number>[]}
 */
function chain(source, depth) {
  /** @type {Derived<number>[]} */
  const nodes = [];
  for (let i = 0; i < depth; i += 1) {
    const previous = nodes[i - 1];
    nodes.push(new Derived(previous ? () => previous.get() : () => source.get()));
  }
  return nodes;
}

describe("a diamond whose two sides are different lengths", () => {
  /**
   * @param {(deep: Derived<number>) => () => number} wrap
   */
  function measure(wrap) {
    const source = Signal.of(1);
    const nodes = chain(source, 5);
    const deep = nodes[4];
    const shallow = nodes[0];
    const readDeep = wrap(deep);
    // `deep` and `shallow` are always equal, so this is always 0.
    const join = new Derived(() => readDeep() - shallow.get());
    /** @type {number[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(join.get()));
    seen.length = 0;
    source.set(2);
    const evaluations = join.getEvaluations();
    effect.dispose();
    return { seen, evaluations };
  }

  it("never shows a value that was never true — read directly", () => {
    const { seen } = measure((deep) => () => deep.get());
    assert.deepStrictEqual(
      seen.filter((v) => v !== 0),
      [],
    );
  });

  it("never shows a value that was never true — read through an observable", () => {
    // The case this whole design exists for. Under a push model the wrapper
    // hid the deep node's position in the graph, the join was scheduled as
    // though it sat one level above a source, and it computed against a value
    // five levels out of date — emitting a number the graph never held.
    //
    // Pulling asks the deep node for its value at the moment the join needs
    // it, which resolves the whole chain first. There is nothing for a
    // wrapper to hide.
    const { seen } = measure((deep) => {
      const source$ = toObservable(deep);
      return () => valueOf(source$);
    });
    assert.deepStrictEqual(
      seen.filter((v) => v !== 0),
      [],
    );
  });

  it("costs the same either way", () => {
    const direct = measure((deep) => () => deep.get());
    const wrapped = measure((deep) => {
      const source$ = toObservable(deep);
      return () => valueOf(source$);
    });
    assert.strictEqual(wrapped.evaluations, direct.evaluations);
  });

  it("survives an arbitrary rxjs pipeline in the middle", () => {
    const { seen } = measure((deep) => {
      const source$ = rx(toObservable(deep)).pipe(
        map((v) => v * 3),
        map((v) => v / 3),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      return () => valueOf(source$);
    });
    assert.deepStrictEqual(
      seen.filter((v) => v !== 0),
      [],
    );
  });
});

describe("the graph carries no notion of depth", () => {
  it("has no priority to get wrong", () => {
    // Kept as a test rather than a comment because it is the load-bearing
    // claim: there is no per-node ordering number anywhere, so there is
    // nothing for a wrapper to drop, nothing to recompute on every
    // evaluation, and nothing to keep in step with a graph that changes shape.
    const source = Signal.of(1);
    const derived = new Derived(() => source.get());
    for (const node of [source, derived]) {
      assert.strictEqual(
        /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (node)).priority,
        undefined,
        "no node carries a priority",
      );
    }
  });

  it("orders a join by the read that happens, not by a number", () => {
    // The join reads its two inputs in the opposite order to the one they
    // were created in, and reads one of them conditionally. No static
    // measurement of this graph would describe it correctly; the call stack
    // does, because it is made of the reads themselves.
    const source = Signal.of(1);
    const flag = Signal.of(false);
    const a = new Derived(() => source.get() + 1);
    const b = new Derived(() => a.get() * 2);
    const join = new Derived(() => (flag.get() ? b.get() - a.get() : 0));
    const effect = new Effect(() => join.get());

    assert.strictEqual(join.get(), 0);
    flag.set(true);
    assert.strictEqual(join.get(), 2, "b === 2a, so b - a === a");
    source.set(10);
    assert.strictEqual(join.get(), 11);
    effect.dispose();
  });
});

describe("crossing the RxJS boundary", () => {
  it("takes a value in through fromObservable and out through toObservable", () => {
    const subject = new ReplaySubject(1);
    subject.next(1);
    const incoming = fromObservable(subject);
    const doubled = new Derived(() => incoming.get() * 2);
    /** @type {number[]} */
    const out = [];
    const subscription = toObservable(doubled).subscribe({ next: (v) => out.push(v) });

    assert.deepStrictEqual(out, [2]);
    subject.next(5);
    assert.deepStrictEqual(out, [2, 10]);

    subscription.unsubscribe();
  });

  it("holds the source open only while somebody is reading", () => {
    let subscriptions = 0;
    const source = {
      subscribe: () => {
        subscriptions += 1;
        return {
          unsubscribe: () => {
            subscriptions -= 1;
          },
        };
      },
    };
    const node = fromObservable(/** @type {never} */ (source));
    assert.strictEqual(subscriptions, 0, "nothing is reading yet");
    const effect = new Effect(() => {
      try {
        node.get();
      } catch {
        // no value yet, which is the point — the subscription is what matters
      }
    });
    assert.strictEqual(subscriptions, 1);
    effect.dispose();
    assert.strictEqual(subscriptions, 0);
  });

  it("does not evaluate a derived node nobody has subscribed to", () => {
    let evaluations = 0;
    const source = Signal.of(1);
    const derived = new Derived(() => {
      evaluations += 1;
      return source.get();
    });
    const out$ = toObservable(derived);
    source.set(2);
    assert.strictEqual(evaluations, 0, "an unsubscribed observable is cold");
    const subscription = out$.subscribe({});
    assert.strictEqual(evaluations, 1);
    subscription.unsubscribe();
  });

  it("keeps observable() readable back into the graph", () => {
    const source = Signal.of(1);
    const out$ = observable(() => source.get() * 3);
    const reader = new Derived(() => valueOf(out$));
    const effect = new Effect(() => reader.get());
    assert.strictEqual(reader.get(), 3);
    source.set(4);
    assert.strictEqual(reader.get(), 12);
    effect.dispose();
  });
});
