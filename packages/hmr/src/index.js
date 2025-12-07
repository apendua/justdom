import { BehaviorSubject, switchMap } from "rxjs";

/**
 * @import { Observable } from "rxjs";
 */

/** @type {Array<BehaviorSubject<any>>} */
let factories = [];

/**
 * @template TValue
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => Observable<TValue>} fn
 * @returns {(...args: TArgs) => Observable<TValue>}
 */
function $factory(fn) {
  // NOTE: We expect that this code will be removed by the bundler
  //       in production builds, so $factory will eseentially be an identity.
  if (import.meta.hot) {
    /** @type {BehaviorSubject<(...args: TArgs) => Observable<TValue>>} */
    const subject = new BehaviorSubject(fn);
    factories.push(subject);
    /**
     * @param {TArgs} args
     */
    return (...args) => {
      return subject.asObservable().pipe(switchMap((f) => f(...args)));
    };
  }
  return fn;
}

$factory.get = () => {
  const result = factories;
  factories = [];
  return result;
};

export { $factory };
