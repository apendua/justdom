import { Observable, switchAll, switchMap } from "rxjs";
import {
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
 * @param {() => T} fn
 * @return {T}
 */
export function autorun(fn) {
  return new Derived(fn).get();
}

/**
 * @template T
 * @param {() => T} fn
 * @return {Observable<T>}
 */
export function $autorun(fn) {
  return toObservable(new Derived(fn));
}

/**
 * @template T, U
 * @param {(value: T) => Observable<U>} fn
 * @returns {(source: Observable<T>) => Observable<U>}
 */
export function reactiveMap(fn) {
  return switchMap((value) => {
    return $autorun(() => fn(value)).pipe(switchAll());
  });
}

/**
 * @template T
 * @param {(value: T) => Observable<void>} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effect(fn) {
  return switchMap((value) => {
    return new Observable((subscriber) => {
      subscriber.next(value);
      subscriber.add(fn(value).pipe(takeNothing()).subscribe(subscriber));
    });
  });
}

/**
 * @template T
 * @param {(value: T) => void} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function reactiveEffect(fn) {
  return effect((value) => {
    return $autorun(() => fn(value));
  });
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
  return $autorun(() => {
    fn(value);
    return value;
  });
}

/**
 * @template {object} T
 * @template {Partial<T>} U
 * @param {U} obj
 * @param {T} defaultValues
 * @returns {T & U}
 */
export function defaults(obj, defaultValues) {
  return /** @type {T & U} */ (
    new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (value !== undefined) {
          return value;
        }
        return /** @type {any} */ (defaultValues)[prop];
      },
    })
  );
}
