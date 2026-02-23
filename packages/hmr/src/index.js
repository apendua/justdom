import { BehaviorSubject, switchAll, switchMap } from "rxjs";

/**
 * @import { Observable } from "rxjs";
 */

/**
 * @template {unknown[]} TArgs
 * @template TValue
 * @typedef {(...args: TArgs) => Observable<TValue>} Factory
 */

/**
 * @template {unknown[]} TArgs
 * @template {unknown[]} TArgs2
 * @template TValue
 * @typedef {(...args: TArgs) => Factory<TArgs2, TValue>} MetaFactory
 */

/**
 * @template TValue
 * @template {unknown[]} TArgs
 * @overload
 * @param {string} name
 * @param {Factory<TArgs, TValue>} fn
 * @returns {Factory<TArgs, TValue>}
 */

/**
 * @template TValue
 * @template {unknown[]} TArgs
 * @template {unknown[]} TArgs2
 * @overload
 * @param {string} name
 * @param {MetaFactory<TArgs, TArgs2, TValue>} fn
 * @returns {MetaFactory<TArgs, TArgs2, TValue>}
 */

/**
 * @type {Record<string, BehaviorSubject<any>>}
 */
let currentReloadable = {};

/**
 * @param {string} name
 * @param {Factory<unknown[], unknown> | MetaFactory<unknown[], unknown[], unknown>} fn
 * @returns {(...args: unknown[]) => (Observable<unknown> | Factory<unknown[], unknown>)}
 */
export function $reloadable(name, fn) {
  return (...args) => {
    const observableOrFactory = fn(...args);
    if (typeof observableOrFactory === "function") {
      const subject = new BehaviorSubject(observableOrFactory);
      currentReloadable[name] = subject;
      /**
       * @param {unknown[]} args2
       */
      return (...args2) => {
        return subject.asObservable().pipe(switchMap((f) => f(...args2)));
      };
    }
    const subject = new BehaviorSubject(observableOrFactory);
    currentReloadable[name] = subject;
    return subject.asObservable().pipe(switchAll());
  };
}

export function $newReloader() {
  const reloadable = { ...currentReloadable };
  currentReloadable = {};
  /**
   * @param {Record<string, any>} newModule
   */
  return (newModule) => {
    Object.keys(newModule).forEach((key) => {
      if (reloadable[key]) {
        reloadable[key].next(newModule[key]);
      }
    });
  };
}
