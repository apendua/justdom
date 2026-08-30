import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";

import {
  Signal,
  Derived,
  Effect,
  batch,
  useEffect,
  CircularDependencyError,
  UpdateChannel,
} from "./index.js";

/**
 * Where a failure goes.
 *
 * There are two of them, and they are not the same thing. An **error thrown**
 * by a `Derived` or an `Effect` body travels the *pull* path: it comes back
 * out of the read that provoked it, up the call stack of reads, until
 * something catches it — an `onError`, or in the end the writer whose
 * `set()` drained the queue. It is not terminal; the node that threw is asked
 * again next time something moves.
 *
 * A **node failure** — `fail()`, which is what a foreign source erroring turns
 * into — travels the *push* path: down every dependency edge to the dependents
 * and observers, and it is terminal.
 *
 * These tests are about the first, and about the seam between the two, because
 * the interesting cases are the ones where a failure has to cross a boundary
 * the throw cannot see over: an effect nested inside another effect, or inside
 * a `Derived`. The rule that comes out of them is worth stating up front —
 * **a nested effect's *first* run is on the builder's stack and its failure
 * goes to the builder; every run after that comes off the queue, with no
 * builder underneath, and goes to the writer instead.**
 */

/**
 * A `Derived` that returns `source`'s value until it hits `boomAt`, and throws
 * from then on. The shape almost every test here needs.
 *
 * @param {Signal<number>} source
 * @param {number} boomAt
 * @param {string} [message]
 * @returns {Derived<number>}
 */
function brokenAt(source, boomAt, message = "boom") {
  return new Derived(() => {
    const value = source.get();
    if (value === boomAt) {
      throw new Error(message);
    }
    return value;
  });
}

/**
 * Run `fn` with `console.error` silenced, handing back what it logged. Several
 * of these tests provoke a failure with nobody listening, which the library
 * reports rather than drops — and which would otherwise be printed in the
 * middle of a passing test run.
 *
 * @template T
 * @param {() => T} fn
 * @returns {{ result: T, logged: unknown[][] }}
 */
function captureConsoleError(fn) {
  const error = mock.method(console, "error", () => {});
  try {
    const result = fn();
    return { result, logged: error.mock.calls.map((call) => call.arguments) };
  } finally {
    error.mock.restore();
  }
}

describe("an error thrown inside a Derived", () => {
  it("comes back out of the read that provoked it", () => {
    const source = Signal.of(1);
    const broken = brokenAt(source, 1, "read me");
    assert.throws(() => broken.get(), /read me/);
  });

  it("is remembered rather than recomputed, so a second read costs nothing", () => {
    // The `#error` cache. A node that is held open answers a repeated read the
    // same way without running the function again — the same bargain a cached
    // value gets.
    const source = Signal.of(1);
    const broken = brokenAt(source, 1);
    const holder = new Effect(() => {
      try {
        broken.get();
      } catch {
        // held open on purpose; the failure is the point
      }
    });

    const evaluations = broken.getEvaluations();
    assert.throws(() => broken.get(), /boom/);
    assert.throws(() => broken.get(), /boom/);
    assert.equal(broken.getEvaluations(), evaluations, "answered from the cache");
    holder.dispose();
  });

  it("is thrown afresh on every read while nothing holds the node open", () => {
    // Unconnected, so there is nothing keeping a cache coherent and nothing is
    // cached — including the error. Each read runs the function again, exactly
    // as each read of a working unconnected node recomputes it.
    const source = Signal.of(1);
    const broken = brokenAt(source, 1);

    assert.throws(() => broken.get(), /boom/);
    assert.equal(broken.getEvaluations(), 1);
    assert.throws(() => broken.get(), /boom/);
    assert.equal(broken.getEvaluations(), 2);
  });

  it("travels a whole chain of Deriveds untouched", () => {
    const source = Signal.of(1);
    const broken = brokenAt(source, 2, "at the top");
    const middle = new Derived(() => broken.get() + 1);
    const leaf = new Derived(() => middle.get() * 10);
    /** @type {unknown[]} */
    const seen = [];
    const holder = new Effect(() => {
      try {
        seen.push(leaf.get());
      } catch (err) {
        seen.push(/** @type {Error} */ (err).message);
      }
    });

    source.set(2);
    source.set(3);
    assert.deepEqual(seen, [20, "at the top", 40], "through two links each way");
    holder.dispose();
  });

  it("is the very error the body threw, not a wrapper", () => {
    const source = Signal.of(1);
    const failure = new Error("this exact object");
    const broken = new Derived(() => {
      source.get();
      throw failure;
    });
    const middle = new Derived(() => broken.get());
    /** @type {unknown[]} */
    const seen = [];
    const holder = new Effect(() => middle.get(), { onError: (err) => seen.push(err) });

    assert.equal(seen.length, 1);
    assert.equal(seen[0], failure, "identity survives the trip, so a stack does too");
    holder.dispose();
  });

  it("reaches the reading effect's onError", () => {
    const source = Signal.of(1);
    const broken = brokenAt(source, 2);
    /** @type {string[]} */
    const seen = [];
    const holder = new Effect(() => broken.get(), {
      onError: (err) => seen.push(/** @type {Error} */ (err).message),
    });

    source.set(2);
    assert.deepEqual(seen, ["boom"]);
    holder.dispose();
  });

  it("comes out at the writer when nothing along the way handles it", () => {
    // The end of the pull path. With no `onError` anywhere the throw keeps
    // going: out of the effect's run, out of the drain the write started, and
    // into the hands of whoever wrote.
    const source = Signal.of(1);
    const broken = brokenAt(source, 2, "reached the writer");
    const holder = new Effect(() => broken.get());

    assert.throws(() => source.set(2), /reached the writer/);
    holder.dispose();
  });

  it("comes out of the batch when the write was inside one", () => {
    const source = Signal.of(1);
    const broken = brokenAt(source, 2, "out of the batch");
    const holder = new Effect(() => broken.get());

    assert.throws(() => batch(() => source.set(2)), /out of the batch/);
    holder.dispose();
  });

  it("reaches every dependent, not only the first", () => {
    const source = Signal.of(1);
    const broken = brokenAt(source, 2);
    /** @type {string[]} */
    const seen = [];
    const first = new Effect(() => broken.get(), { onError: () => seen.push("first") });
    const second = new Effect(() => broken.get(), { onError: () => seen.push("second") });

    source.set(2);
    assert.deepEqual(seen, ["first", "second"]);
    first.dispose();
    second.dispose();
  });

  it("stops being thrown once an evaluation succeeds again", () => {
    // Not terminal, unlike a node failure. The node is asked again when
    // something it read moves, and a run that returns clears the error.
    const source = Signal.of(2);
    const broken = brokenAt(source, 2);
    /** @type {unknown[]} */
    const seen = [];
    const holder = new Effect(() => {
      try {
        seen.push(broken.get());
      } catch (err) {
        seen.push(/** @type {Error} */ (err).message);
      }
    });

    source.set(3);
    source.set(2);
    source.set(4);
    assert.deepEqual(seen, ["boom", 3, "boom", 4]);
    holder.dispose();
  });

  it("answers a direct read with the new value once it succeeds again", () => {
    // The same recovery, taken by the other route into `get`. An effect
    // reading the node resolves it on the way in and then takes the cached
    // path out, which never looks at the error at all; a bare subscription
    // holds the node open without reading it, so the read itself is what
    // recomputes and the answer comes from the branch that does look.
    const source = Signal.of(2);
    const broken = brokenAt(source, 2);
    const subscription = broken.subscribe({});

    assert.throws(() => broken.get(), /boom/);
    source.set(3);
    assert.equal(broken.get(), 3, "the error the last run left is gone with it");
    subscription.unsubscribe();
  });

  it("is re-thrown by peek, which computes nothing", () => {
    const source = Signal.of(1);
    const broken = brokenAt(source, 1);
    const holder = new Effect(() => {
      try {
        broken.get();
      } catch {
        // held open
      }
    });

    const evaluations = broken.getEvaluations();
    assert.throws(() => broken.peek(), /boom/);
    assert.equal(broken.getEvaluations(), evaluations, "peek never evaluates");
    holder.dispose();
  });

  it("throws rather than hangs when the node reads itself round a cycle", () => {
    // A cycle is a failure of the graph rather than of a body, and the read
    // that closed it is what has to be told. `Signal.test.js` covers the
    // unconnected read, where `#evaluating` catches it. Held open, the
    // recursion instead reaches a node whose state was settled to `CLEAN`
    // before its evaluation began — so the guard's own `updateIfNecessary`
    // returns early and never sees it — and whose value does not exist yet.
    // `get` is where that is caught, because `get` is where the missing value
    // turns up; it used to be a `TypeError` about a property of null.
    /** @type {Derived<number>} */
    const a = new Derived(() => b.get() + 1);
    /** @type {Derived<number>} */
    const b = new Derived(() => a.get() + 1);
    const subscription = a.subscribe({});

    assert.throws(() => a.get(), CircularDependencyError);
    subscription.unsubscribe();
  });

  it("is not a node failure, so an error subscriber is not told", () => {
    // The distinction this file is about. A thrown error is news for whoever
    // *reads*; `subscribe` is the push side, and all it hears is that the node
    // may have moved. Only `fail()` — a source dying — reaches an `error`.
    const source = Signal.of(1);
    const broken = brokenAt(source, 2);
    /** @type {string[]} */
    const seen = [];
    const subscription = broken.subscribe({
      next: () => seen.push("next"),
      error: () => seen.push("error"),
    });
    broken.get();

    source.set(2);
    assert.deepEqual(seen, ["next"], "told it moved, not told it died");
    assert.throws(() => broken.get(), /boom/, "and the error is still there for a reader");
    assert.equal(broken.failure, null, "the node is not dead");
    subscription.unsubscribe();
  });
});

describe("an error thrown inside an Effect", () => {
  it("comes out of the constructor, and the effect lets go of what it read", () => {
    // An effect that could not get through its first run has no business
    // staying subscribed to what it managed to read on the way.
    const source = Signal.of(1);
    const derived = new Derived(() => source.get());

    assert.throws(() => {
      new Effect(() => {
        derived.get();
        throw new Error("first run");
      });
    }, /first run/);
    assert.equal(derived.isConnected(), false, "nothing is holding it open any more");
  });

  it("comes out of the constructor for a deferred effect too", () => {
    // A deferred first run is queued rather than performed, but nothing is
    // batching, so the queue drains before the constructor returns and the
    // throw still lands on the caller.
    const source = Signal.of(1);
    assert.throws(() => {
      new Effect(
        () => {
          source.get();
          throw new Error("deferred first run");
        },
        { deferred: true },
      );
    }, /deferred first run/);
  });

  it("goes to onError on a re-run, and the effect carries on", () => {
    const source = Signal.of(1);
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(
      () => {
        const value = source.get();
        if (value === 2) {
          throw new Error("boom");
        }
        seen.push(value);
      },
      { onError: (err) => seen.push(/** @type {Error} */ (err).message) },
    );

    source.set(2);
    source.set(3);
    assert.deepEqual(seen, [1, "boom", 3], "handled, so it is still listening");
    assert.equal(effect.isDisposed, false);
    effect.dispose();
  });

  it("comes out at the writer when there is no onError", () => {
    const source = Signal.of(1);
    const effect = new Effect(() => {
      if (source.get() === 2) {
        throw new Error("at the writer");
      }
    });

    assert.throws(() => source.set(2), /at the writer/);
    effect.dispose();
  });

  it("leaves the effect usable, because a throw is not a failure", () => {
    const source = Signal.of(1);
    /** @type {number[]} */
    const seen = [];
    const effect = new Effect(() => {
      const value = source.get();
      if (value === 2) {
        throw new Error("boom");
      }
      seen.push(value);
    });

    assert.throws(() => source.set(2), /boom/);
    source.set(3);
    assert.deepEqual(seen, [1, 3], "the next write is served as though nothing happened");
    assert.equal(effect.isDisposed, false);
    effect.dispose();
  });

  it("comes out of a batch, leaving the queue clean behind it", () => {
    // A half-drained multi-channel state is harder to reason about than a
    // clean slate, so the drain that threw clears every lane — which means the
    // bystander loses its turn, and gets it back on the next write.
    const source = Signal.of(1);
    /** @type {string[]} */
    const seen = [];
    const exploding = new Effect(() => {
      if (source.get() === 2) {
        throw new Error("mid-drain");
      }
    });
    const bystander = new Effect(() => seen.push(`saw ${source.get()}`));

    seen.length = 0;
    assert.throws(() => batch(() => source.set(2)), /mid-drain/);
    assert.deepEqual(seen, [], "the drain was abandoned before it got here");

    exploding.dispose();
    source.set(3);
    assert.deepEqual(seen, ["saw 3"], "and the queue works again afterwards");
    bystander.dispose();
  });

  it("comes out of flush when a caller runs the effect ahead of its channel", () => {
    /** @type {Subject<void>} */
    const trigger = new Subject();
    const channel = new UpdateChannel({ name: "later", order: 1, trigger });
    const source = Signal.of(1);
    const effect = new Effect(
      () => {
        if (source.get() === 2) {
          throw new Error("out of flush");
        }
      },
      { channel },
    );

    source.set(2);
    assert.throws(() => effect.flush(), /out of flush/);
    effect.dispose();
  });

  it("ignores a failure reported after the effect has been disposed", () => {
    // A run that took a subscription hands out `fail`, the effect is disposed,
    // and the subscription errors on its way out. There is nothing left to
    // fail, and nobody left to tell.
    /** @type {(err: unknown) => void} */
    let report = () => {};
    const effect = new Effect(({ fail }) => {
      report = fail;
    });
    effect.dispose();

    const { logged } = captureConsoleError(() => report(new Error("too late")));
    assert.deepEqual(logged, [], "not reported, because it is not news");
    assert.equal(effect.failure, null, "and the effect was already gone");
  });

  it("comes out at the writer when a teardown throws", () => {
    // The teardown of the previous run is called on the way into the next one,
    // so it fails into whatever provoked that run.
    const source = Signal.of(1);
    const effect = new Effect(() => {
      source.get();
      return () => {
        throw new Error("teardown");
      };
    });

    assert.throws(() => source.set(2), /teardown/);
    captureConsoleError(() => effect.dispose());
  });
});

describe("an effect nested inside another effect", () => {
  it("hands its first run's failure to the run that built it", () => {
    // The inner effect is constructed *during* the outer run, so its first run
    // is on the outer run's stack and the throw simply travels up it.
    /** @type {string[]} */
    const seen = [];
    const outer = new Effect(
      () => {
        useEffect(() => {
          throw new Error("inner first run");
        });
      },
      { onError: (err) => seen.push(/** @type {Error} */ (err).message) },
    );

    assert.deepEqual(seen, ["inner first run"]);
    outer.dispose();
  });

  it("carries a three-deep first-run failure to the outermost handler", () => {
    /** @type {string[]} */
    const seen = [];
    const outer = new Effect(
      () => {
        useEffect(() => {
          useEffect(() => {
            throw new Error("deepest");
          });
        });
      },
      { onError: (err) => seen.push(/** @type {Error} */ (err).message) },
    );

    assert.deepEqual(seen, ["deepest"], "two stacks up, unchanged");
    outer.dispose();
  });

  it("lets an inner onError contain the failure", () => {
    const source = Signal.of(1);
    /** @type {string[]} */
    const seen = [];
    const outer = new Effect(
      () => {
        useEffect(() => source.get() === 2 && fail(), {
          onError: () => seen.push("inner"),
        });
      },
      { onError: () => seen.push("outer") },
    );
    function fail() {
      throw new Error("boom");
    }

    source.set(2);
    assert.deepEqual(seen, ["inner"], "handled where it was handled, and no further");
    outer.dispose();
  });

  it("does not route a re-run's failure through the outer effect", () => {
    // The boundary. A re-run comes off the queue with no builder underneath
    // it, so there is no stack back to the outer effect and its `onError`
    // never sees this. The throw goes where every unhandled effect throw goes:
    // out of the drain, at the writer.
    const source = Signal.of(1);
    /** @type {string[]} */
    const seen = [];
    const outer = new Effect(
      () => {
        useEffect(() => {
          if (source.get() === 2) {
            throw new Error("inner re-run");
          }
        });
      },
      { onError: () => seen.push("outer") },
    );

    assert.throws(() => source.set(2), /inner re-run/);
    assert.deepEqual(seen, [], "the outer effect is not in the path any more");
    outer.dispose();
  });

  it("does not route a failure reported after an inner run through the outer effect either", () => {
    // `context.fail` is the push side, and an effect has no dependents — so
    // there is nobody above it at all, builder or otherwise. Unhandled, it
    // fails the inner effect and is logged rather than dropped.
    /** @type {string[]} */
    const seen = [];
    /** @type {(err: unknown) => void} */
    let report = () => {};
    /** @type {Effect | undefined} */
    let inner;
    const outer = new Effect(
      () => {
        inner = useEffect(
          ({ fail }) => {
            report = fail;
          },
          { name: "inner" },
        );
      },
      { onError: () => seen.push("outer") },
    );

    const { logged } = captureConsoleError(() => report(new Error("after the run")));

    assert.deepEqual(seen, [], "not the outer effect's to hear");
    assert.equal(inner?.isDisposed, true, "the inner effect stops");
    assert.equal(logged.length, 1, "and it is reported rather than lost");
    assert.match(String(logged[0][0]), /Unhandled failure in Effect "inner"/);
    outer.dispose();
  });

  it("lets a subscriber on the inner effect hear that failure", () => {
    // Which is the answer to the previous test: if a nested effect's
    // after-the-fact failures matter, give it an `onError` or subscribe to it.
    // Nesting alone does not make the outer effect a handler.
    /** @type {string[]} */
    const seen = [];
    /** @type {(err: unknown) => void} */
    let report = () => {};
    /** @type {Effect | undefined} */
    let inner;
    const outer = new Effect(() => {
      inner = useEffect(({ fail }) => {
        report = fail;
      });
    });
    inner?.subscribe({ error: (err) => seen.push(/** @type {Error} */ (err).message) });

    report(new Error("heard"));
    assert.deepEqual(seen, ["heard"]);
    outer.dispose();
  });

  it("disposes the whole nest when the outermost throw is left unhandled", () => {
    const derived = new Derived(() => 1);
    /** @type {Effect | undefined} */
    let inner;

    assert.throws(() => {
      new Effect(() => {
        inner = useEffect(() => derived.get());
        throw new Error("outer first run");
      });
    }, /outer first run/);

    assert.equal(inner?.isDisposed, true, "the outer's dispose took the inner with it");
    assert.equal(derived.isConnected(), false, "so nothing is left holding the graph open");
  });
});

describe("an effect nested inside a Derived", () => {
  it("fails the derived's evaluation when the inner effect's first run throws", () => {
    // The inner effect's first run is on the *derived's* evaluation stack, so
    // the throw is caught where every failed evaluation is caught — and from
    // there it is the derived's error, handed to the derived's reader.
    const source = Signal.of(1);
    const derived = new Derived(() => {
      useEffect(() => {
        throw new Error("effect in a derived");
      });
      return source.get();
    });
    /** @type {string[]} */
    const seen = [];
    const holder = new Effect(() => derived.get(), {
      onError: (err) => seen.push(/** @type {Error} */ (err).message),
    });

    assert.deepEqual(seen, ["effect in a derived"]);
    holder.dispose();
  });

  it("routes the inner effect's re-run to the writer, not to the derived's reader", () => {
    // Same boundary as one effect nested in another, and for the same reason:
    // a re-run has no builder underneath it, so there is no derived
    // evaluation to fail and no reader to hand it to.
    const source = Signal.of(1);
    const derived = new Derived(() => {
      useEffect(() => {
        if (source.get() === 2) {
          throw new Error("inner re-run");
        }
      });
      return 1;
    });
    /** @type {string[]} */
    const seen = [];
    const holder = new Effect(() => derived.get(), { onError: () => seen.push("holder") });

    assert.throws(() => source.set(2), /inner re-run/);
    assert.deepEqual(seen, [], "the derived's reader is not in the path");
    holder.dispose();
  });

  it("carries a first-run failure up through effect > derived > effect > derived", () => {
    // The full alternating stack the pull model claims to see through: the
    // innermost read throws, the effect reading it is on the derived's
    // evaluation stack, and that derived is being read by the outermost
    // effect. One stack, four frames, one handler at the top.
    const source = Signal.of(1);
    const broken = brokenAt(source, 1, "innermost");
    const middle = new Derived(() => {
      useEffect(() => broken.get());
      return 1;
    });
    /** @type {string[]} */
    const seen = [];
    const outer = new Effect(() => middle.get(), {
      onError: (err) => seen.push(/** @type {Error} */ (err).message),
    });

    assert.deepEqual(seen, ["innermost"]);
    outer.dispose();
  });

  it("comes out at the writer when nothing in the stack handles it", () => {
    const source = Signal.of(1);
    const derived = new Derived(() => {
      useEffect(() => {
        if (source.get() === 2) {
          throw new Error("nobody handled this");
        }
      });
      return source.get();
    });
    const outer = new Effect(() => derived.get());

    assert.throws(() => source.set(2), /nobody handled this/);
    outer.dispose();
  });
});

describe("a node failure, which is the other kind", () => {
  it("travels every edge of a chain and reaches the root subscriber", () => {
    /** @type {Subject<number>} */
    const subject = new Subject();
    const source = Derived.from(subject);
    const middle = new Derived(() => source.get() + 1);
    /** @type {string[]} */
    const seen = [];
    const leaf = new Effect(
      () => {
        try {
          middle.get();
        } catch {
          // waiting for the first value
        }
      },
      { name: "leaf" },
    );
    leaf.subscribe({ error: (err) => seen.push(/** @type {Error} */ (err).message) });

    subject.error(new Error("the source died"));
    assert.deepEqual(seen, ["the source died"], "two links down, to the one thing listening");
    assert.notEqual(middle.failure, null, "and the links themselves are dead");
  });

  it("is handed to a subscriber that arrives after it", () => {
    // Terminal, so there is no news to wait for: a late subscriber is told at
    // once rather than left listening to a node that will never speak again.
    /** @type {Subject<number>} */
    const subject = new Subject();
    const source = Derived.from(subject);
    const early = source.subscribe({ error: () => {} });

    subject.error(new Error("already dead"));
    /** @type {string[]} */
    const seen = [];
    source.subscribe({ error: (err) => seen.push(/** @type {Error} */ (err).message) });

    assert.deepEqual(seen, ["already dead"]);
    early.unsubscribe();
  });

  it("is handed to a dependent that starts reading after it", () => {
    /** @type {Subject<number>} */
    const subject = new Subject();
    const source = Derived.from(subject);
    const early = source.subscribe({ error: () => {} });
    subject.error(new Error("already dead"));

    /** @type {string[]} */
    const seen = [];
    /** @type {Effect | undefined} */
    let latecomer;
    /** @type {string[]} */
    const read = [];
    captureConsoleError(() => {
      latecomer = new Effect(() => {
        try {
          source.get();
        } catch (err) {
          read.push(/** @type {Error} */ (err).message);
        }
      });
      latecomer.subscribe({ error: (err) => seen.push(/** @type {Error} */ (err).message) });
    });

    assert.notEqual(latecomer?.failure, null, "reading a dead node kills the reader");
    assert.equal(latecomer?.isDisposed, true);
    assert.deepEqual(read, ["already dead"], "and the read itself is told why");
    early.unsubscribe();
  });

  it("stops a read of the node that died, rather than answering it", () => {
    // The two paths meeting. `fail` walks the push side; a read arrives from
    // the other direction and has to be told the same thing, or a dead node
    // goes on handing out values computed from a source that will never speak
    // again.
    const source = Signal.of(1);
    const derived = new Derived(() => source.get() * 2);
    const holder = derived.subscribe({ error: () => {} });
    assert.equal(derived.get(), 2);

    derived.fail(new Error("killed"));
    assert.throws(() => derived.get(), /killed/);
    assert.throws(() => derived.peek(), /killed/, "and peek says the same");
    holder.unsubscribe();
  });

  it("stops a read of a Signal that died, and takes its value with it", () => {
    // A signal holds its value, so unlike a `Derived` it is still sitting on
    // one when it dies — and answering with it would be handing out a reading
    // from an instrument that has stopped.
    const source = Signal.of(1);
    const holder = source.subscribe({ error: () => {} });
    assert.equal(source.get(), 1);

    source.fail(new Error("the sensor died"));
    assert.throws(() => source.get(), /the sensor died/);
    assert.throws(() => source.peek(), /the sensor died/, "and peek says the same");
    assert.equal(source.hasValue(), false, "there is no value to have any more");
    holder.unsubscribe();
  });

  it("tells a reader of a dead Signal apart from one that is merely waiting", () => {
    // The distinction the two answers carry. A `NoValueError` is a "not yet"
    // the graph waits on — the effect stays subscribed and runs again when
    // the value arrives. A failure is news that it never will, and an effect
    // handed one has to stop rather than wait for something that cannot come.
    /** @type {Signal<number>} */
    const pending = new Signal();
    /** @type {string[]} */
    const seen = [];
    const waiting = new Effect(() => seen.push(`value ${pending.get()}`));
    // Counted rather than compared against `[]`: `deepEqual` asserts `actual
    // is T`, so matching an empty literal here would narrow `seen` to
    // `never[]` for the rest of the test and fail the pushes below.
    assert.equal(seen.length, 0, "waiting, not failed");

    pending.set(1);
    assert.deepEqual(seen, ["value 1"], "and it was still listening");

    const dying = Signal.of(1);
    const reader = new Effect(() => dying.get(), {
      onError: (err) => seen.push(/** @type {Error} */ (err).message),
    });
    captureConsoleError(() => dying.fail(new Error("gone for good")));

    assert.equal(reader.isDisposed, true, "the reader stops rather than waiting");
    waiting.dispose();
  });

  it("is what a read gets instead of a NoValueError about the value it lost", () => {
    // The shape this takes in an application. The observable behind a
    // `Derived.from` errors, so the signal it was writing into never gets a
    // value — and a read used to be answered by the evaluation, which failed
    // for having nothing to read. "No value available" is a poor account of a
    // source that died.
    /** @type {Subject<number>} */
    const subject = new Subject();
    const source = Derived.from(subject);
    const holder = source.subscribe({ error: () => {} });

    subject.error(new Error("the source died"));
    assert.throws(() => source.get(), /the source died/);
    holder.unsubscribe();
  });

  it("is said once, however many times it is reported", () => {
    // Terminal means terminal: the node has already told everyone and let go
    // of everything, so a second failure has nowhere to go and no one to go
    // to. Without the guard the observers list is empty by now, and the second
    // failure would be logged as unhandled.
    const source = Signal.of(1);
    const derived = new Derived(() => source.get());
    /** @type {string[]} */
    const seen = [];
    derived.subscribe({ error: (err) => seen.push(/** @type {Error} */ (err).message) });

    derived.fail(new Error("first"));
    const { logged } = captureConsoleError(() => derived.fail(new Error("second")));

    assert.deepEqual(seen, ["first"]);
    assert.deepEqual(logged, [], "the second one is not news either");
  });

  it("disposes an effect it reaches, whichever direction it came from", () => {
    // An effect is not read, so letting go of its edges is not the whole of
    // stopping it the way it is for a `Derived`: it is a root of demand with a
    // slot in a queue. A failure its own run reports disposes it, and one
    // propagating down from something it reads has to do the same — or the
    // effect answers `isDisposed` with `false` for ever while nothing will
    // ever run it again.
    const source = Signal.of(1);
    const derived = new Derived(() => source.get());
    const effect = new Effect(() => derived.get());
    effect.subscribe({ error: () => {} });
    const runs = effect.getRuns();

    derived.fail(new Error("killed"));
    source.set(2);

    assert.equal(effect.getRuns(), runs, "it will not run again");
    assert.equal(effect.isDisposed, true, "and it says so");
    assert.equal(effect.isLive(), false);
  });
});
