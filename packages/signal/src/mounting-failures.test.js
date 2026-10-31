import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Observable, Subject } from "rxjs";

import { just } from "./factories.js";
import { use, useEffects } from "./operators.js";
import { Effect, useEffect } from "./Effect.js";
import { fromObservable, toEffect, toObservable } from "./interop.js";
import { Derived } from "./Derived.js";
import { valueOf } from "./core.js";
import { Signal } from "./Signal.js";

/**
 * How a mounting hears that it failed.
 *
 * These are the cases measured in `docs/signal-mounting-failure-channel.md`,
 * turned into assertions. The contract they pin, in one sentence: **a failure
 * that ends up handled is never reported as unhandled on the way, and a
 * nested effect's failure reaches the computation that built it** — however
 * early the failure arrives, first run included.
 *
 * Two mechanisms carry that. An `Effect` that cannot get through
 * construction throws, whichever kind of failure stopped it and whether or
 * not it was given an `onError` — which closes the window `just`, `toEffect`
 * and `toObservable` all had between running a mounting's effect and
 * listening to it, because the builder's own stack is underneath the whole
 * of it. And `useEffect` wires a failure edge from the inner effect to the
 * surrounding computation, which is what gives a nested effect's failure a
 * path to the mounting once it stands — `standalone: true` opts out.
 *
 * The one case deliberately *not* rerouted is an inner effect's body
 * throwing on a later run with no `onError`: that is the pull path, and it
 * still comes out at the writer — see `errors.test.js`, which owns that
 * boundary.
 */

/**
 * Run `fn` with `console.error` silenced, handing back what the subscriber
 * heard and what the graph reported as unhandled. Every test here asserts on
 * both halves, because both halves are the contract.
 *
 * @param {(heard: unknown[]) => void} fn
 * @returns {{ heard: unknown[], reports: number }}
 */
function measure(fn) {
  const error = mock.method(console, "error", () => {});
  /** @type {unknown[]} */
  const heard = [];
  try {
    fn(heard);
  } finally {
    error.mock.restore();
  }
  return { heard, reports: error.mock.calls.length };
}

const failsOnSubscribe = () =>
  new Observable(() => {
    throw new Error("on the way in");
  });

describe("how a mounting hears that it failed", () => {
  it("hands a dependency failing on the way in to the subscriber, quietly", () => {
    // Case A. `use(source)` attaches the source as a dependency of the
    // mounting's own effect, and the source errors during that effect's
    // *first run* — before `just` could ever have subscribed to the effect
    // after the fact. The constructor-time observer is what hears it.
    const { heard, reports } = measure((heard) =>
      just({}, [() => use(failsOnSubscribe())]).subscribe({ error: (e) => heard.push(e) }),
    );
    assert.equal(heard.length, 1, "the subscriber was told");
    assert.match(String(heard[0]), /on the way in/);
    assert.equal(reports, 0, "and nothing was reported as unhandled");
  });

  it("hands a dependency failing once the mounting stands to the subscriber", () => {
    // Case A′ — the half that always worked, pinned so it stays working.
    const { heard, reports } = measure((heard) => {
      /** @type {Subject<never>} */
      const s = new Subject();
      just({}, [() => use(s)]).subscribe({ error: (e) => heard.push(e) });
      s.error(new Error("later"));
    });
    assert.equal(heard.length, 1);
    assert.equal(reports, 0);
  });

  it("tells the mounting when a nested effect's dependency dies", () => {
    // Case B — the hole that lost failures. The inner `useEffect` reads a
    // node whose source errors later; nothing but `useEffect`'s failure edge
    // connects that inner effect to the mounting.
    const { heard, reports } = measure((heard) => {
      /** @type {Subject<number>} */
      const s = new Subject();
      just({}, [
        () => {
          const node = fromObservable(s);
          useEffect(() => node.get());
        },
      ]).subscribe({ error: (e) => heard.push(e) });
      s.next(1);
      s.error(new Error("later"));
    });
    assert.equal(heard.length, 1, "the mounting heard it through the failure edge");
    assert.equal(reports, 0);
  });

  it("does the same when the inner effect has an onError", () => {
    // Case B′. A failure arriving down a dependency edge goes to
    // `Effect.fail` and never consults `onError` — the edge is what carries
    // it, with or without one.
    const { heard, reports } = measure((heard) => {
      /** @type {Subject<number>} */
      const s = new Subject();
      just({}, [
        (entity, { fail }) => {
          const node = fromObservable(s);
          useEffect(() => node.get(), { onError: fail });
        },
      ]).subscribe({ error: (e) => heard.push(e) });
      s.next(1);
      s.error(new Error("later"));
    });
    assert.equal(heard.length, 1);
    assert.equal(reports, 0);
  });

  it("keeps a standalone inner effect's failure away from the mounting", () => {
    // The opt-out, end to end: the inner effect dies alone and is reported,
    // the mounting stands, and the subscriber hears nothing.
    /** @type {{ value: number }} */
    const entity = { value: 0 };
    const counter = Signal.of(1);
    const { heard, reports } = measure((heard) => {
      /** @type {Subject<number>} */
      const s = new Subject();
      just(entity, [
        (obj) => {
          const node = fromObservable(s);
          useEffect(() => void node.get(), { standalone: true });
          useEffect(() => {
            obj.value = counter.get();
          });
        },
      ]).subscribe({ error: (e) => heard.push(e) });
      s.next(1);
      s.error(new Error("alone"));
    });
    assert.equal(heard.length, 0, "the mounting was not told");
    assert.equal(reports, 1, "the failure was reported rather than lost");
    counter.set(2);
    assert.equal(entity.value, 2, "and the mounting still stands");
  });

  it("carries a first-run failure up through useEffects without a report per level", () => {
    // Case C. `useEffects` nests the window: an entity effect mounts inner
    // effects, whose dependency fails on the way in. This used to produce one
    // unhandled-failure report per level before the subscriber was told.
    const { heard, reports } = measure((heard) =>
      just({}, [() => useEffects({}, [() => use(failsOnSubscribe())])]).subscribe({
        error: (e) => heard.push(e),
      }),
    );
    assert.equal(heard.length, 1, "told synchronously, through both levels");
    assert.equal(reports, 0, "with no report at either level");
  });

  it("routes a later throw to the mounting when the inner effect asks with onError", () => {
    // Case D′. A body throw on a re-run is the pull path — without an
    // `onError` it comes out at the writer (see `errors.test.js`) — but
    // `onError: fail` lands it on the mounting's channel.
    const { heard, reports } = measure((heard) => {
      const s = Signal.of(0);
      just({}, [
        (entity, { fail }) =>
          useEffect(
            () => {
              if (s.get() > 0) {
                throw new Error("later throw");
              }
            },
            { onError: fail },
          ),
      ]).subscribe({ error: (e) => heard.push(e) });
      s.set(1);
    });
    assert.equal(heard.length, 1);
    assert.equal(reports, 0);
  });

  it("hands a nested first-run throw to the subscriber synchronously", () => {
    // Case E. The inner effect's first run is on the mounting's stack, so the
    // throw travels it — no channels involved, and nothing to report.
    const { heard, reports } = measure((heard) =>
      just({}, [
        () =>
          useEffect(() => {
            throw new Error("first throw");
          }),
      ]).subscribe({ error: (e) => heard.push(e) }),
    );
    assert.equal(heard.length, 1);
    assert.equal(reports, 0);
  });

  it("tells a toEffect subscriber when a dependency fails, however early", () => {
    // The same window and the same lost channel, one layer down: `mountEach`
    // and `effectsOnly` mount through `toEffect`, whose subscriber used to
    // hear body throws but not dependency failures.
    const sync = measure((heard) =>
      toEffect(() => use(failsOnSubscribe())).subscribe({ error: (e) => heard.push(e) }),
    );
    assert.equal(sync.heard.length, 1, "a failure from the first run is delivered");
    assert.equal(sync.reports, 0);

    const later = measure((heard) => {
      /** @type {Subject<never>} */
      const s = new Subject();
      toEffect(() => use(s)).subscribe({ error: (e) => heard.push(e) });
      s.error(new Error("later"));
    });
    assert.equal(later.heard.length, 1, "and so is one that arrives once it stands");
    assert.equal(later.reports, 0);
  });

  it("reports nothing when a node dies during the read toObservable triggers", () => {
    // The node's own failure was always heard — `toObservable` subscribes the
    // node before building its effect — but the effect it killed on the way
    // was not, and said so on `console.error`.
    const { heard, reports } = measure((heard) => {
      const node = new Derived(() => valueOf(failsOnSubscribe()));
      toObservable(node).subscribe({ error: (e) => heard.push(e) });
    });
    assert.equal(heard.length, 1);
    assert.equal(reports, 0);
  });

  it("rethrows a first-run dependency failure from the constructor", () => {
    // The primitive under all of the above, pinned directly. A failure that
    // lands while the first run is still on the stack is parked and delivered
    // the moment the run unwinds — and while the constructor is on the stack
    // there is nowhere better to deliver it than the constructor, so a
    // dependency that dies on the way in comes out of `new Effect` exactly as
    // a body that threw would. No report, because the throw is the delivery.
    const { heard, reports } = measure((heard) => {
      try {
        new Effect(() => use(failsOnSubscribe()));
      } catch (err) {
        heard.push(err);
      }
    });
    assert.equal(heard.length, 1);
    assert.match(String(heard[0]), /on the way in/);
    assert.equal(reports, 0);
  });

  it("does the same when an onError was passed", () => {
    // `onError` is the effect's listener of last resort *once it stands*, and
    // passing one does not make a failure during mounting survivable. Which
    // is what lets every caller above hand its subscriber an `onError` and
    // still have the half-built mounting come down on its own stack, without
    // a flag and a rethrow to restore the default.
    const { heard, reports } = measure((heard) => {
      /** @type {unknown[]} */
      const handled = [];
      try {
        new Effect(() => use(failsOnSubscribe()), {
          onError: (err) => handled.push(err),
        });
      } catch (err) {
        heard.push(err);
      }
      assert.deepEqual(handled, [], "onError was not consulted");
    });
    assert.equal(heard.length, 1);
    assert.match(String(heard[0]), /on the way in/);
    assert.equal(reports, 0);
  });
});
