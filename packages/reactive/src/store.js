import { filter, Subject } from "rxjs";
import { addDependency, batch, Derived, withComputation } from "@apendua.dev/signal";
import Emitter from "./Emitter.js";
import { useEffects } from "./operators.js";
import { memoize, isPlainObject } from "./util.js";

/**
 * @import {MonoTypeOperatorFunction} from "rxjs"
 * @import {IEmitter} from "./Emitter.js";
 */

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
 * @param {object} value
 */
function ownKeysNoComputation(value) {
  return withComputation(null, () => Reflect.ownKeys(value));
}

/**
 * @param {unknown} value
 * @return {value is Record<PropertyKey, unknown>}
 */
function isPlainObjectNoComputation(value) {
  return withComputation(null, () => isPlainObject(value));
}

/**
 * @param {Record<PropertyKey, unknown>} oldValue
 * @param {Record<PropertyKey, unknown>} newValue
 */
export function replace(oldValue, newValue) {
  batch(() => {
    Object.assign(oldValue, newValue);
    for (const k of ownKeysNoComputation(oldValue)) {
      if (!Reflect.has(newValue, k)) {
        delete oldValue[k];
      }
    }
  });
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
  /** @type {Record<PropertyKey, unknown>} */
  const state = withComputation(null, () => {
    if (!isPlainObject(data)) {
      throw new Error("Store can only be created from a plain object");
    }
    const newData = { ...data };
    for (const [key, value] of Object.entries(newData)) {
      if (isPlainObject(value)) {
        newData[key] = store(value);
      }
    }
    return newData;
  });
  /** @type {Subject<{ key: PropertyKey }>} */
  const changes = new Subject();
  const ownKeys = Symbol("ownKeys");

  /** @type {Map<PropertyKey, Derived<unknown>>} */
  const derived = new Map();

  /** @type {Map<PropertyKey, () => unknown>} */
  const getters = new Map();
  /** @type {Map<PropertyKey, (value: unknown) => void>} */
  const setters = new Map();

  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(data))) {
    if (descriptor.get) {
      getters.set(key, descriptor.get);
    }
    if (descriptor.set) {
      setters.set(key, descriptor.set);
    }
  }

  /**
   * @param {PropertyKey} key
   */
  const getChangesAtKey = memoize((/** @type {PropertyKey} */ key) =>
    changes.pipe(filter((change) => change.key === key)),
  );

  /** @type {Emitter<Record<PropertyKey, unknown>>} */
  const eventListener = new Emitter();
  const addEventListener = eventListener.addEventListener.bind(eventListener);
  const removeEventListener = eventListener.removeEventListener.bind(eventListener);

  const proxy = new Proxy(state, {
    get(_, key, receiver) {
      if (key === "addEventListener") {
        return addEventListener;
      }
      if (key === "removeEventListener") {
        return removeEventListener;
      }
      addDependency(getChangesAtKey(key));
      const getter = getters.get(key);
      if (!getter) {
        return state[key];
      }
      let signal = derived.get(key);
      if (!signal) {
        signal = new Derived(() => getter.call(receiver));
        derived.set(key, signal);
      }
      return signal.get();
    },
    set(_, key, newValue, receiver) {
      const setter = setters.get(key);
      if (setter) {
        setter.call(receiver, newValue);
      } else {
        if (isPlainObject(newValue)) {
          const oldValue = state[key];
          // We need to use non-reactive version of isPlainObject to prevent accidentally creating
          // a circular dependency on oldValue should it be a store itself.
          if (isPlainObjectNoComputation(oldValue)) {
            replace(oldValue, newValue);
            return true;
          }
          newValue = store(newValue);
        }
        if (Object.is(state[key], newValue)) {
          return true;
        }
        state[key] = newValue;
        changes.next({ key });
        changes.next({ key: ownKeys });
      }
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
