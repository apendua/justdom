import { Stream } from "./Stream.js";

/**
 * @import { Source } from "./subscribable.js";
 */

/**
 * A count that starts after `due` milliseconds and, if a `period` is given,
 * carries on every `period` after that.
 *
 * `timer(ms)` emits `0` once and finishes. `timer(ms, period)` emits `0`, then
 * `1`, `2`, and so on, and never finishes on its own. `interval(period)` below
 * is the second form with both numbers the same, which is where the count
 * starting at the end of the first period rather than at zero comes from.
 *
 * **Cold, like everything else here.** Each subscriber gets a timer of its
 * own, and unsubscribing clears it. That is the right default — a source that
 * schedules work should stop scheduling it when nobody is listening — but it
 * does mean two subscribers tick independently, and neither sees the other's
 * count. A clock that several things must share is a node over one of these:
 * `toObservable(fromObservable(interval(…)))` holds one timer however many
 * read it, and lets go of it when the last one does.
 *
 * A negative delay is treated as zero, which is what the platform's own timers
 * do with one.
 *
 * @param {number} due Milliseconds before the first value.
 * @param {number} [period] Milliseconds between the ones after it. Omit for a
 *   source that emits once and completes.
 * @returns {Source<number>}
 */
export function timer(due, period) {
  return new Stream((subscriber) => {
    let count = 0;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let repeat;
    const first = setTimeout(
      () => {
        subscriber.next(count);
        count += 1;
        if (period === undefined) {
          subscriber.complete();
          return;
        }
        repeat = setInterval(
          () => {
            subscriber.next(count);
            count += 1;
          },
          Math.max(0, period),
        );
      },
      Math.max(0, due),
    );
    return () => {
      clearTimeout(first);
      if (repeat !== undefined) {
        clearInterval(repeat);
      }
    };
  });
}

/**
 * `0`, `1`, `2`, … one every `period` milliseconds, the first one a whole
 * period in rather than straight away.
 *
 * @param {number} period
 * @returns {Source<number>}
 */
export function interval(period) {
  return timer(period, period);
}
