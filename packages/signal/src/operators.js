import { Observable } from "rxjs";
import { NoValueError, withComputation } from "./core.js";

/**
 * @import {Dependency} from "./core.js"
 */

/**
 * @template T
 * @param {Dependency & { get: () => T }} signal
 * @return {Observable<T>}
 */
export function toObservable(signal) {
  return new Observable((subscriber) => {
    const subscription = signal.subscribe({
      next: () => {
        try {
          withComputation(null, () => {
            subscriber.next(signal.get());
          });
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
      withComputation(null, () => {
        subscriber.next(signal.get());
      });
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
