import { filter, Subject } from "rxjs";
import { addDependency, Changes } from "@apendua.dev/signal";
import Emitter from "./Emitter.js";
import { useEffects } from "./operators.js";

/**
 * @import {MonoTypeOperatorFunction} from "rxjs"
 * @import {IEmitter} from "./Emitter.js";
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

/** @type {WeakMap<object, Emitter<Record<PropertyKey, unknown>>>} */
const emitters = new WeakMap();

/**
 * @template {IEmitter<Record<any, any>>} T
 * @template {keyof T["__EVENT_MAP__"]} TEvent
 * @param {T} data
 * @param {TEvent} event
 * @param {T["__EVENT_MAP__"][TEvent]} payload
 * @return {void}
 */
export function emit(data, event, payload) {
  let emitter = emitters.get(data);
  if (emitter) {
    emitter.emit(event, payload);
  }
}

/**
 * @template {object} T
 * @template {object} [TEventMap={}]
 * @overload
 * @param {T} data
 * @param {Array<MonoTypeOperatorFunction<T & IEmitter<TEventMap>>>} [operators]
 * @return {T & IEmitter<TEventMap>}
 */

/**
 * @param {object} data
 * @param {Array<MonoTypeOperatorFunction<unknown>>} [operators]
 * @return {object}
 */
function store(data, operators = []) {
  // TODO(@apendua): Handle array methods to trigger reactivity.
  const state = /** @type {Record<PropertyKey, unknown>} */ ({ ...data });
  /** @type {Subject<{ key: PropertyKey }>} */
  const changes = new Subject();
  const ownKeys = Symbol("ownKeys");

  /**
   * @param {PropertyKey} key
   */
  const getChangesAtKey = memoize(
    (key) => new Changes(changes.pipe(filter((change) => change.key === key))),
  );

  /** @type {WeakMap<object, object>} */
  const cache = new WeakMap();
  /** @type {Emitter<Record<PropertyKey, unknown>>} */
  const eventListener = new Emitter();
  const addEventListener = eventListener.addEventListener.bind(eventListener);
  const removeEventListener = eventListener.removeEventListener.bind(eventListener);

  const proxy = new Proxy(state, {
    get(_, key) {
      if (key === "addEventListener") {
        return addEventListener;
      }
      if (key === "removeEventListener") {
        return removeEventListener;
      }
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
      if (Object.is(state[key], value)) {
        return true;
      }
      state[key] = value;
      changes.next({ key });
      changes.next({ key: ownKeys });
      return true;
    },
    has(_, key) {
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
      addDependency(getChangesAtKey(ownKeys));
      return Reflect.ownKeys(state);
    },
  });

  emitters.set(proxy, eventListener);
  useEffects(proxy, operators);
  return proxy;
}

export default store;
