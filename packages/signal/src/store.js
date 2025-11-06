import { filter, ReplaySubject, Subject } from "rxjs";
// import { memoize } from "./utils.js";
import { addDependency, Changes, Source } from "./Signal.js";
import { all, setEffects } from "./operators.js";

/**
 * @import {MonoTypeOperatorFunction, Observable} from "rxjs"
 */

/**
 * @param {unknown} value
 * @return {value is Record<PropertyKey, unknown>}
 */
function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.constructor === Object &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * @template T, U
 * @param {(value: T) => U} fn
 * @return {(value: T) => U}
 */
function memoize(fn) {
  /** @type {Map<T, U>} */
  const cache = new Map();
  return (arg) => {
    if (cache.has(arg)) {
      return /** @type {U} */ (cache.get(arg));
    }
    const result = fn(arg);
    cache.set(arg, result);
    return result;
  };
}

/**
 * @template {object} T
 * @overload
 * @param {T} data
 * @param {Array<MonoTypeOperatorFunction<T>>} [operators]
 * @return {T}
 */

/**
 * @param {object} data
 * @param {Array<MonoTypeOperatorFunction<object>>} [operators]
 * @return {object}
 */
function store(data, operators = []) {
  // TODO(@apendua): Handle array methods to trigger reactivity.
  const state = /** @type {Record<PropertyKey, unknown>} */ ({ ...data });
  /** @type {Subject<{ key: PropertyKey }>} */
  const changes = new Subject();
  const ownKeys = Symbol("ownKeys");

  /** @type {Subject<object>} */
  const subject = new ReplaySubject(1);
  const effects = new Source(subject.pipe(all(operators)));

  /**
   * @param {PropertyKey} key
   */
  const getChangesAtKey = memoize(
    (key) => new Changes(changes.pipe(filter((change) => change.key === key))),
  );

  /** @type {WeakMap<object, object>} */
  const cache = new WeakMap();

  const proxy = new Proxy(state, {
    get(_, key) {
      addDependency(effects);
      addDependency(getChangesAtKey(key));
      if (isPlainObject(state[key])) {
        let storeAtKey = cache.get(state[key]);
        if (!storeAtKey) {
          storeAtKey = store(state[key]);
          cache.set(state[key], storeAtKey);
        }
        return storeAtKey;
      }
      return state[key];
    },
    set(_, key, value) {
      if (state[key] === value) {
        return true;
      }
      state[key] = value;
      changes.next({ key });
      changes.next({ key: ownKeys });
      return true;
    },
    has(_, key) {
      addDependency(effects);
      addDependency(getChangesAtKey(key));
      return key in state;
    },
    deleteProperty(_, key) {
      delete state[key];
      changes.next({ key });
      changes.next({ key: ownKeys });
      return true;
    },
    ownKeys() {
      addDependency(effects);
      addDependency(getChangesAtKey(ownKeys));
      return Reflect.ownKeys(state);
    },
  });

  subject.next(proxy);
  setEffects(proxy, effects);

  return /** @type {T} */ (proxy);
}

export default store;
