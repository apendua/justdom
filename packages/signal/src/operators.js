import { BehaviorSubject, Observable, switchAll, switchMap } from "rxjs";
import {
  addDependency,
  Derived,
  Initial,
  NoValueError,
  Source,
} from "./Signal.js";

/**
 * @import {MonoTypeOperatorFunction} from "rxjs"
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
 * @param {(value: T) => U} fn
 * @returns {(source: Observable<T>) => Observable<U>}
 */
export function autorunMap(fn) {
  return switchMap((value) => {
    return $autorun(() => fn(value));
  });
}

/**
 * @template T
 * @param {() => Observable<T>} fn
 * @returns {T}
 */
export function reactive(fn) {
  return new Source(autorun(fn)).get();
}

/**
 * @template T
 * @param {() => Observable<T>} fn
 * @returns {Observable<T>}
 */
export function $reactive(fn) {
  return $autorun(fn).pipe(switchAll());
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
 * @param {(value: T) => Observable<unknown>} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effectMap(fn) {
  return switchMap((value) => {
    return new Observable((subscriber) => {
      subscriber.next(value);
      subscriber.add(
        fn(value).subscribe({
          error: (err) => {
            subscriber.error(err);
          },
        }),
      );
    });
  });
}

/** @type {WeakMap<object, Dependency>} */
const ownEffects = new WeakMap();

/**
 * @template {object} T
 * @param {T} obj
 * @param {Dependency | Array<MonoTypeOperatorFunction<T>>} effects
 */
export function setEffects(obj, effects) {
  if (Array.isArray(effects)) {
    const subject = new BehaviorSubject(obj);
    ownEffects.set(obj, new Source(subject.pipe(all(effects))));
  } else {
    ownEffects.set(obj, effects);
  }
}

/**
 * @template T
 * @param {T} value
 * @returns {Observable<T>}
 */
export function just(value) {
  if (typeof value === "object" && value !== null) {
    const effects = ownEffects.get(value);
    if (effects) {
      return $autorun(() => {
        addDependency(effects);
        return value;
      });
    }
  }
  return new Observable((subscriber) => {
    subscriber.next(value);
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

/**
 * @template T
 * @param {Array<MonoTypeOperatorFunction<T>>} operators
 * @returns {MonoTypeOperatorFunction<T>}
 */
export function all(operators) {
  return (source) => {
    return operators.reduce((obs, fn) => fn(obs), source);
  };
}
