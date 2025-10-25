import { Observable } from "rxjs";
import {
  addDependency,
  Dedupe,
  Derived,
  Initial,
  invalidate,
  NullSignal,
} from "./Signal.js";

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
        subscriber.next(signal.get());
      },
      error: (err) => {
        subscriber.error(err);
      },
    });
    try {
      subscriber.next(signal.get());
    } catch (err) {
      subscription.unsubscribe();
      subscriber.error(err);
      return;
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

/**
 * @template T
 * @param {() => T} fn
 */
export function derived(fn) {
  const signal = new Derived(fn);
  return {
    get: () => signal.get(),
  };
}

/**
 * @template T
 * @param {() => T} fn
 * @return {Observable<T>}
 */
export function $reactive(fn) {
  return toObservable(new Derived(fn));
}

/**
 * @template T
 * @param {T} value
 */
export function initial(value) {
  const signal = new Initial(value);
  return {
    get: () => signal.get(),
    set: (/** @type {T} */ v) => signal.set(v),
  };
}

/**
 * @template T
 * @param {number} [priority=0]
 * @returns {(source: Observable<T>) => Observable<Dependency>}
 */
export function toSignal(priority = 0) {
  return (source) => {
    const signal = new NullSignal(priority);
    return new Observable((subscriber) => {
      subscriber.add(
        source.subscribe({
          next: () => {
            invalidate(() => {
              subscriber.next(signal);
              return signal;
            });
          },
          error: (err) => {
            subscriber.error(err);
          },
          complete: () => {
            subscriber.complete();
          },
        }),
      );
    });
  };
}

/**
 * @returns {(source: Observable<Dependency>) => Observable<Dependency>}
 */
export function dedupe() {
  return (source) => {
    return new Observable((subscriber) => {
      new Dedupe(source).getChanges().subscribe(subscriber);
    });
  };
}

/**
 * @template T
 * @returns {(source: Observable<T>) => Observable<never>}
 */
export function takeNothing() {
  return (source) => {
    return new Observable((subscriber) => {
      const subscription = source.subscribe({
        complete: () => subscriber.complete(),
        error: (err) => subscriber.error(err),
      });
      return () => {
        subscription.unsubscribe();
      };
    });
  };
}

/**
 * @param {Observable<unknown>} observable
 */
export function subscribeTo(observable) {
  addDependency(new Dedupe(observable.pipe(takeNothing())));
}

/**
 * @param {Observable<unknown>} observable
 */
export function invalidateOn(observable) {
  addDependency(new Dedupe(observable.pipe(toSignal())));
}

/**
 * @param {() => void} fn
 */
export function autorun(fn) {
  const signal = new Derived(() => {
    fn();
    return {};
  });
  addDependency(signal);
}

/**
 * @param {() => void} fn
 * @return {Observable<never>}
 */
export function $autorun(fn) {
  return new Observable((subscriber) => {
    const signal = new Derived(() => {
      fn();
      return {};
    });
    const subscription = signal.getChanges().subscribe({
      error: (err) => {
        subscriber.error(err);
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  });
}

/**
 * @template T
 * @param {T} value
 * @param {(value: T) => void} fn
 * @return {Observable<T>}
 */
export function $withEffects(value, fn) {
  return $reactive(() => {
    fn(value);
    return value;
  });
}

/**
 * @param {() => (void | (() => void))} fn
 */
export function effect(fn) {
  const signal = new Derived((ctx) => {
    const cleanup = fn();
    if (typeof cleanup === "function") {
      ctx.onInvalidate(cleanup);
    }
    return {};
  });
  addDependency(signal);
}

/**
 * @param {() => (void | (() => void))} fn
 */
export function $effect(fn) {
  return new Observable((subscriber) => {
    const signal = new Derived((ctx) => {
      const cleanup = fn();
      if (typeof cleanup === "function") {
        ctx.onInvalidate(cleanup);
      }
      return {};
    });
    const subscription = signal.getChanges().subscribe({
      error: (err) => {
        subscriber.error(err);
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  });
  // return $reactive(() => {
  //   const cleanup = fn();
  //   // By returning a new function, we ensure that the cleanup is always called
  //   // even if the same cleanup function is returned multiple times.
  //   return () => {
  //     if (typeof cleanup === "function") {
  //       cleanup();
  //     }
  //   };
  // }).pipe(
  //   switchMap((cleanup) => {
  //     return new Observable(() => cleanup);
  //   }),
  // );
}
