import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { firstValueFrom } from "rxjs";
import { Stream } from "./Stream.js";
import { rx } from "./rxjs.js";

describe("Stream", () => {
  it("runs its subscribe function once per subscriber", () => {
    let runs = 0;
    const stream = new Stream(() => {
      runs += 1;
    });

    assert.strictEqual(runs, 0, "cold: nothing happens until somebody subscribes");

    const first = stream.subscribe();
    const second = stream.subscribe();
    assert.strictEqual(runs, 2, "and each subscriber gets its own run");

    first.unsubscribe();
    second.unsubscribe();
  });

  it("takes an observer or a bare function", () => {
    const stream = new Stream((subscriber) => {
      subscriber.next("value");
    });

    /** @type {string[]} */
    const seen = [];
    stream.subscribe((value) => seen.push(`fn:${value}`)).unsubscribe();
    stream.subscribe({ next: (value) => seen.push(`observer:${value}`) }).unsubscribe();
    stream.subscribe().unsubscribe();

    assert.deepStrictEqual(seen, ["fn:value", "observer:value"]);
  });

  it("runs the teardown once, when the subscriber leaves", () => {
    let teardowns = 0;
    const stream = new Stream(() => () => {
      teardowns += 1;
    });

    const subscription = stream.subscribe();
    assert.strictEqual(teardowns, 0);

    subscription.unsubscribe();
    assert.strictEqual(teardowns, 1);

    subscription.unsubscribe();
    assert.strictEqual(teardowns, 1, "unsubscribing twice undoes it once");
  });

  it("stops at completion, and takes the teardown down with it", () => {
    let teardowns = 0;
    /** @type {(value: number) => void} */
    let emit = () => {};
    /** @type {() => void} */
    let finish = () => {};
    const stream = new Stream((subscriber) => {
      emit = (value) => subscriber.next(value);
      finish = () => subscriber.complete();
      return () => {
        teardowns += 1;
      };
    });

    /** @type {number[]} */
    const seen = [];
    let completed = false;
    stream.subscribe({
      next: (value) => seen.push(value),
      complete: () => {
        completed = true;
      },
    });

    emit(1);
    finish();
    emit(2);

    assert.deepStrictEqual(seen, [1], "nothing arrives after completion");
    assert.ok(completed);
    assert.strictEqual(teardowns, 1);
  });

  it("stops at a failure, and takes the teardown down with it", () => {
    let teardowns = 0;
    /** @type {(value: number) => void} */
    let emit = () => {};
    /** @type {(err: unknown) => void} */
    let fail = () => {};
    const stream = new Stream((subscriber) => {
      emit = (value) => subscriber.next(value);
      fail = (err) => subscriber.error(err);
      return () => {
        teardowns += 1;
      };
    });

    /** @type {number[]} */
    const seen = [];
    /** @type {unknown[]} */
    const failures = [];
    stream.subscribe({
      next: (value) => seen.push(value),
      error: (err) => failures.push(err),
    });

    emit(1);
    fail(new Error("boom"));
    emit(2);
    fail(new Error("again"));

    assert.deepStrictEqual(seen, [1]);
    assert.strictEqual(failures.length, 1, "the first failure ends it; later ones are ignored");
    assert.strictEqual(teardowns, 1);
  });

  it("routes a throw from the subscribe function to the observer", () => {
    const failure = new Error("boom");
    const stream = new Stream(() => {
      throw failure;
    });

    /** @type {unknown} */
    let caught;
    stream.subscribe({ error: (err) => (caught = err) });

    assert.strictEqual(caught, failure);
  });

  it("runs a teardown owed by a source that failed on the way in", () => {
    // The `toObservable` case: subscribing to the node replays a stored
    // failure, so the subscriber is closed before the subscribe function has
    // returned — but the ear it took on the way in is still owed a teardown.
    let teardowns = 0;
    const stream = new Stream((subscriber) => {
      subscriber.error(new Error("stored failure"));
      return () => {
        teardowns += 1;
      };
    });

    stream.subscribe({ error: () => {} });
    assert.strictEqual(teardowns, 1, "the teardown ran even though nothing waited for it");
  });

  it("tells the source when there is nobody left to talk to", () => {
    /** @type {boolean[]} */
    const observed = [];
    const stream = new Stream((subscriber) => {
      observed.push(subscriber.closed);
      subscriber.error(new Error("boom"));
      observed.push(subscriber.closed);
    });

    stream.subscribe({ error: () => {} });
    assert.deepStrictEqual(observed, [false, true]);
  });

  it("delivers nothing to a subscriber that left mid-emission", () => {
    /** @type {(value: number) => void} */
    let emit = () => {};
    const stream = new Stream((subscriber) => {
      emit = (value) => subscriber.next(value);
    });

    /** @type {number[]} */
    const seen = [];
    const subscription = stream.subscribe((value) => {
      seen.push(value);
      subscription.unsubscribe();
    });

    emit(1);
    emit(2);

    assert.deepStrictEqual(seen, [1]);
  });

  it("undoes everything the source added, in the order it was taken on", () => {
    /** @type {string[]} */
    const undone = [];
    const stream = new Stream((subscriber) => {
      subscriber.add(() => undone.push("first"));
      subscriber.add({ unsubscribe: () => undone.push("second") });
      return () => undone.push("returned last");
    });

    const subscription = stream.subscribe();
    assert.deepStrictEqual(undone, []);

    subscription.unsubscribe();
    assert.deepStrictEqual(undone, ["first", "second", "returned last"]);

    subscription.unsubscribe();
    assert.deepStrictEqual(undone, ["first", "second", "returned last"], "and only once");
  });

  it("undoes at once anything added after it closed", () => {
    /** @type {string[]} */
    const undone = [];
    const stream = new Stream((subscriber) => {
      subscriber.complete();
      subscriber.add(() => undone.push("late"));
    });

    stream.subscribe();
    assert.deepStrictEqual(undone, ["late"], "a leak is the only other option");
  });

  it("runs every teardown even when one of them throws", () => {
    /** @type {string[]} */
    const undone = [];
    const stream = new Stream((subscriber) => {
      subscriber.add(() => {
        throw new Error("bad teardown");
      });
      subscriber.add(() => undone.push("still ran"));
    });

    const subscription = stream.subscribe();
    assert.throws(() => subscription.unsubscribe(), /bad teardown/);
    assert.deepStrictEqual(undone, ["still ran"]);
  });

  it("lifts into RxJS through rx(), which is what the seam is for", async () => {
    const stream = new Stream((subscriber) => {
      subscriber.next("carried across");
      subscriber.complete();
    });

    assert.strictEqual(await firstValueFrom(rx(stream)), "carried across");
  });

  it("is cold through rx() too: one run per subscriber, undone on unsubscribe", () => {
    let runs = 0;
    let teardowns = 0;
    const stream = new Stream(() => {
      runs += 1;
      return () => {
        teardowns += 1;
      };
    });

    const observable = rx(stream);
    const first = observable.subscribe();
    const second = observable.subscribe();
    assert.strictEqual(runs, 2);

    first.unsubscribe();
    second.unsubscribe();
    assert.strictEqual(teardowns, 2);
  });
});
