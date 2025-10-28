import { Observable } from "rxjs";
import {
  addDependency,
  Changes,
  Dedupe,
  Derived,
  Initial,
  NoValueError,
  Source,
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
 * @returns {(source: Observable<T>) => Observable<Source<T>>}
 */
export function toSource() {
  return (source) => {
    return new Source(source).getChanges();
  };
}

/**
 * @template T
 * @returns {(source: Observable<T>) => Observable<Changes>}
 */
export function toChanges() {
  return (source) => {
    return new Changes(source).getChanges();
  };
}

/**
 * @param {number} [priority=1]
 * @returns {(source: Observable<Dependency>) => Observable<Dependency>}
 */
export function dedupe(priority = 1) {
  return (source) => {
    return new Observable((subscriber) => {
      new Dedupe(source, priority).getChanges().subscribe(subscriber);
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
 * @template T
 * @param {Observable<unknown>} notifier
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function takeUntilCompleted(notifier) {
  return (source) => {
    return new Observable((subscriber) => {
      source.subscribe(subscriber);
      notifier.pipe(takeNothing()).subscribe(subscriber);
    });
  };
}

/**
 * @param {Observable<unknown>} observable
 */
export function subscribeTo(observable) {
  addDependency(new Changes(observable.pipe(takeNothing())));
}

/**
 * @param {Observable<unknown>} observable
 */
export function invalidateOn(observable) {
  addDependency(new Changes(observable));
}

/**
 * @param {() => void} fn
 */
function createAutorunSignal(fn) {
  return new Derived(() => {
    fn();
    return {};
  });
}

/**
 * @param {() => void} fn
 */
export function autorun(fn) {
  addDependency(createAutorunSignal(fn));
}

/**
 * @param {() => void} fn
 * @return {Observable<never>}
 */
export function $autorun(fn) {
  return toObservable(createAutorunSignal(fn)).pipe(takeNothing());
}

/**
 * @param {() => (void | (() => void))} fn
 */
function createEffectSignal(fn) {
  return new Derived((ctx) => {
    const cleanup = fn();
    if (typeof cleanup === "function") {
      ctx.onInvalidate(cleanup);
    }
    return {};
  });
}

/**
 * @param {() => (void | (() => void))} fn
 */
export function effect(fn) {
  addDependency(createEffectSignal(fn));
}

/**
 * @param {() => (void | (() => void))} fn
 * @return {Observable<never>}
 */
export function $effect(fn) {
  return toObservable(createEffectSignal(fn)).pipe(takeNothing());
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

/**
 * @template T
 * @param {(onInvalidate: (cleanup: () => void) => void) => T} fn
 * @return {Derived<T>}
 */
function createResourceSignal(fn) {
  return new Derived((ctx) => {
    return fn(ctx.onInvalidate.bind(ctx));
  });
}

/**
 * @template T
 * @param {(onInvalidate: (cleanup: () => void) => void) => T} fn
 * @return {Observable<T>}
 */
export function $resource(fn) {
  return toObservable(createResourceSignal(fn));
}

/**
 * @template T
 * @param {T} value
 * @returns {Observable<T>}
 */
export function just(value) {
  return new Observable((subscriber) => {
    subscriber.next(value);
  });
}

/**
 * @template T
 * @param {T} value
 * @param {(value: T) => void} [fn]
 * @returns {Observable<T>}
 */
export function $(value, fn) {
  if (!fn) {
    return just(value);
  }
  return $reactive(() => {
    fn(value);
    return value;
  });
}
