import { Observable } from "rxjs";
import { NoValueError } from "./Signal.js";

/**
 * @import {Dependency} from "./Signal.js"
 */

/**
 * @template T
 * @param {Dependency & { get: () => T }} signal
 * @return {Observable<T>}
 */
export function toObservable(signal) {
  return new Observable((subscriber) => {
    const subscription = signal.getChanges().subscribe({
      next: () => {
        try {
          subscriber.next(signal.get());
        } catch (err) {
          if (err instanceof NoValueError) {
            return;
          }
          throw err;
        }
      },
      error: (err) => {
        subscriber.error(err);
      },
    });
    try {
      subscriber.next(signal.get());
    } catch (err) {
      if (!(err instanceof NoValueError)) {
        subscription.unsubscribe();
        subscriber.error(err);
        return;
      }
    }
    return () => {
      subscription.unsubscribe();
    };
  });
  // TODO: Explain why this does not work.
  // return signal.getChanges().pipe(
  //   startWith(signal),
  //   map(() => signal.get()),
  // );
}
