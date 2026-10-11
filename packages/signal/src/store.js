import { activeComputation, addDependency, withComputation } from "./core.js";
import { Derived } from "./Derived.js";
import { Signal } from "./Signal.js";
import { batch } from "./scheduler.js";
import Emitter from "./Emitter.js";
import { useEffects } from "./operators.js";
import { isPlainObject } from "./util.js";

/**
 * @import {ComputationLike} from "./core.js"
 * @import {EntityEffect} from "./types.js"
 * @typedef {Map<PropertyKey, PropertyDescriptor>} Descriptors
 * @import {IEmitter} from "./Emitter.js";
 */

/**
 * @typedef {object} Internals
 * @property {Emitter<Record<PropertyKey, unknown>>} emitter
 * @property {Record<PropertyKey, unknown>} state An array for a store made
 *   of one, a plain object otherwise.
 * @property {boolean} array Whether `state` is an array. A store keeps the
 *   kind it was made with.
 * @property {Internals | null} owner The store this one was made in, from a
 *   plain object or an array at one of its keys, or `null` for a store made
 *   by a call to `store()`. A reload reshapes a nested store only through
 *   its owner; see `reshape`. Moving it to another index of its owner keeps
 *   the owner, and holding it anywhere else does not change it.
 * @property {Map<PropertyKey, () => unknown>} getters
 * @property {Map<PropertyKey, (value: unknown) => void>} setters
 * @property {Map<PropertyKey, Derived<unknown>>} derived
 * @property {Signal<number> | undefined} definition Bumped when `reshape`
 *   replaces a getter with another. Every getter's `Derived` of this store
 *   reads it, so each recomputes and its readers re-run only if its value
 *   changed by `Object.is`. It is one per store, not one for all, so that a
 *   reload reaches no other store. Made with the store's first getter
 *   `Derived`.
 * @property {(key: PropertyKey) => void} announce
 * @property {symbol} ownKeys The key the key set's readers depend on.
 * @property {ComputationLike | null | undefined} mutator The computation
 *   that called the array method in `arrayMutators` running on the store,
 *   `null` for a call outside any, and `undefined` while none runs. See
 *   there for what it changes.
 * @property {number} held How many keys of its owner hold the store, kept
 *   by every write and removal of a key of the owner's `state`, which the
 *   proxy makes the only ways to change one: it refuses `defineProperty` and
 *   `preventExtensions`. A store held as itself can sit at two keys of its
 *   owner, after `list[1] = list[0]`, `list.meta = list[0]` or a `fill`, and
 *   a write into it through one key would show at the other, so the `set`
 *   trap writes into it in place only while this is 1. Unused for a store
 *   with no owner.
 * @property {Set<PropertyKey> | null} touched The data keys the program has
 *   written or deleted through the proxy since `trackWrites` was called,
 *   which `reshape` keeps. `null` until then, so a store nobody reloads
 *   records nothing.
 */

/**
 * Returns the object it is given, so that a subclass's private field is
 * added to that object rather than to a new one.
 */
class Stamped {
  /** @param {object} target */
  constructor(target) {
    return target;
  }
}

/**
 * Stamps a store's proxy with its `Internals` in a private field, which
 * `emit`, `reshape` and a store used as another's definition read. The field
 * lives on the proxy itself, so reading it runs no trap: a `selector()`
 * evaluates its source for any key, and throws for a source that is not
 * ready. An object whose prototype is a store does not have it, and it is
 * not one of the store's keys, so `in`, `ownKeys` and spread do not see it.
 *
 * A `WeakSet` of every proxy, asked before reading a symbol key through the
 * proxy, did the same job, and adding to it was about a quarter of the cost
 * of making a small store. A `WeakMap` from proxy to record did it before
 * that, at more.
 */
class Brand extends Stamped {
  /** @type {Internals} */
  #internals;

  /**
   * @param {object} proxy
   * @param {Internals} internals
   */
  constructor(proxy, internals) {
    super(proxy);
    this.#internals = internals;
  }

  /**
   * @param {unknown} value
   * @returns {Internals | undefined}
   */
  static internalsOf(value) {
    return typeof value === "object" && value !== null && #internals in value
      ? value.#internals
      : undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {Internals | undefined} The record of `value` if it is a store.
 */
function internalsOf(value) {
  return Brand.internalsOf(value);
}

/**
 * Whether `value` is a store — the proxy `store()` handed back, as opposed to
 * the plain object it was made from. A store is a piece of state: what it
 * holds is what has been written to it, so anything that wants to keep state
 * across a module reload keeps the store itself.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStore(value) {
  return internalsOf(value) !== undefined;
}

/**
 * @template {IEmitter<Record<any, any>>} T
 * @template {keyof T["__EVENT_MAP__"]} TEvent
 * @param {T} data
 * @param {TEvent} event
 * @param {T["__EVENT_MAP__"][TEvent]} payload
 * @return {void}
 */
export function emit(data, event, payload) {
  internalsOf(data)?.emitter.emit(event, payload);
}

/**
 * The array methods that change the array they are called on. On a store,
 * each runs as one batch with the store's `mutator` set to the computation
 * that called it. The method itself is the native one, called on the proxy,
 * so every key it reads and writes goes through the store's traps. Called
 * on anything but a store, it is the native method and nothing more.
 *
 * One batch, because a method writes several keys, an index or two and
 * `length` for a `push`, every index for a `sort`, and a reader of more than
 * one must see the array once it is done rather than once per key.
 *
 * While `mutator` is set, the store's traps record no read of its own keys
 * by the computation that called the method, since each method reads the
 * array it writes, its `length` at least, and an `Effect` that pushes would
 * otherwise depend on the `length` it writes and run again on its own push.
 * Every other read is recorded as any read is. The caller's read of another
 * store registers, such as a `sort` comparator's read of an element store, so
 * an effect that sorts follows what it sorts by, and so does any read by a
 * computation that evaluates while the method runs, such as the `Derived` of a
 * getter the comparator reads.
 *
 * And a plain object or an array written while `mutator` is set always makes a
 * new store at its index, one store per index it is written to, so a `fill`
 * with one object makes as many stores as indices. It is never a write into the
 * store found there: `unshift` and `splice` copy an element up before they
 * write the index it came from, so that store is the one now held one index on.
 * A store is held as itself, as at any time, which is what lets `sort` or
 * `shift` move one.
 *
 * @type {Map<PropertyKey, (this: unknown[], ...args: unknown[]) => unknown>}
 */
const arrayMutators = new Map();
for (const name of [
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]) {
  const method = /** @type {(this: unknown[], ...args: unknown[]) => unknown} */ (
    Reflect.get(Array.prototype, name)
  );
  arrayMutators.set(name, function (...args) {
    const internals = internalsOf(this);
    if (!internals) {
      return method.apply(this, args);
    }
    // Restored inside the batch, before it drains: an effect the method
    // queued re-runs after it, and its reads of the store are its own.
    return batch(() => {
      const previous = internals.mutator;
      internals.mutator = activeComputation;
      try {
        return method.apply(this, args);
      } finally {
        internals.mutator = previous;
      }
    });
  });
}

/**
 * Which kind of store `value` is, or is made into when a store holds it: an
 * array for an array, which has no prototype but `Array.prototype`, and an
 * object for a plain object. Anything else, a `Map`, a typed array, an
 * instance, is held as it is. Reads no key of `value` reactively.
 *
 * @param {unknown} value
 * @returns {"array" | "object" | undefined}
 */
function storeKindOf(value) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const internals = internalsOf(value);
  if (internals) {
    return internals.array ? "array" : "object";
  }
  if (Array.isArray(value)) {
    return Object.getPrototypeOf(value) === Array.prototype ? "array" : undefined;
  }
  return isPlainObjectNoComputation(value) ? "object" : undefined;
}

/**
 * Count `value` in to, or out of, the keys of `internals`' store that hold
 * it, when it is a store that one owns. See `Internals.held`.
 *
 * @param {Internals} internals
 * @param {unknown} value
 * @param {1 | -1} delta
 */
function countHolder(internals, value, delta) {
  const nested = internalsOf(value);
  if (nested?.owner === internals) {
    nested.held += delta;
  }
}

/**
 * The stores `value` holds at its data keys, at any depth through the plain
 * objects and arrays it holds, which a write makes stores of, and not into
 * a store, which is placed as it is. Read without running a getter. `null`
 * when it holds none, which is the common case and allocates nothing.
 *
 * @param {object} value A plain object, an array or a store.
 * @param {Set<unknown> | null} [stores] The set to add to.
 * @returns {Set<unknown> | null}
 */
function storesIn(value, stores = null) {
  const source = /** @type {object} */ (internalsOf(value)?.state ?? value);
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    const held = descriptor.value;
    if (isStore(held)) {
      (stores ??= new Set()).add(held);
    } else if (storeKindOf(held)) {
      stores = storesIn(/** @type {object} */ (held), stores);
    }
  }
  return stores;
}

/**
 * While a `replace` runs, the stores its `newValue` holds at a data key, and
 * those of every `replace` it runs inside, since an in-place write one level
 * down is a `replace` of its own. The `set` trap writes into none of them:
 * the replace is about to place each at a key, so a write into it through
 * another key first would show there. `null` outside any replace.
 *
 * @type {Set<unknown> | null}
 */
let placing = null;

/**
 * Whether `key` is an array index: the canonical string of an integer from
 * 0 to 2 ** 32 - 2.
 *
 * @param {PropertyKey} key
 * @returns {boolean}
 */
function isIndex(key) {
  return typeof key === "string" && String(Number(key) >>> 0) === key && key !== "4294967295";
}

/**
 * Whether the store of `internals` is of `kind`, so that a value of that
 * kind is written into it, or reshapes it, in place.
 *
 * @param {Internals} internals
 * @param {"array" | "object" | undefined} kind
 * @returns {boolean}
 */
function isOfKind(internals, kind) {
  return kind !== undefined && internals.array === (kind === "array");
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
 * Bump a version counter that readers depend on. `setFn` reads the old value
 * non-reactively, so a bump from inside a computation does not make that
 * computation depend on the counter.
 *
 * @param {Signal<number>} version
 */
function bump(version) {
  version.setFn(
    (value) => value + 1,
    () => 1,
  );
}

/**
 * Give `oldValue` the values of `newValue`: assign each of its keys and
 * delete each key it does not have, in one batch.
 *
 * Each value is read from `newValue`, through its getter where it has one,
 * and assigned to `oldValue` as any write is: through `oldValue`'s setter
 * where the key has one; to nothing where the key has a getter and no
 * setter; and to the key itself otherwise. `oldValue`'s getters and setters
 * stay as they are, which only `reshape` changes.
 *
 * An array takes the length of `newValue` as well, so the elements past it
 * go. Each index is assigned as a key is, in order, so a plain object or an
 * array written over a store of its kind that `oldValue` owns, held at that
 * key and at no other by then, is written into that store, and the store
 * stays where it is. A store `newValue` holds at a data key is never written
 * into, through this store or one nested in it, since the replace places it
 * as itself. One a getter of `newValue` returns is not known before the
 * getter runs, and is assigned as any store is.
 *
 * @param {Record<PropertyKey, unknown> | unknown[]} oldValue
 * @param {Record<PropertyKey, unknown> | unknown[]} newValue
 */
export function replace(oldValue, newValue) {
  batch(() => {
    // Set and restored inside the batch, before it drains, as `mutator` is:
    // an effect the replace queued assigns as any assignment does.
    // One set for the whole replace, nested replaces included: each adds
    // only the stores the set does not hold yet, and removes them again, so
    // each store is added and removed once.
    const found = storesIn(newValue);
    const outer = placing;
    /** @type {unknown[] | null} */
    let added = null;
    if (found && outer === null) {
      placing = found;
    } else if (found && outer) {
      for (const held of found) {
        if (!outer.has(held)) {
          outer.add(held);
          (added ??= []).push(held);
        }
      }
    }
    try {
      Object.assign(oldValue, newValue);
      if (Array.isArray(oldValue) && Array.isArray(newValue)) {
        oldValue.length = newValue.length;
      }
      for (const k of ownKeysNoComputation(oldValue)) {
        if (!Reflect.has(newValue, k)) {
          delete (/** @type {Record<PropertyKey, unknown>} */ (oldValue)[k]);
        }
      }
    } finally {
      if (found && outer === null) {
        placing = null;
      } else if (outer && added) {
        for (const held of added) {
          outer.delete(held);
        }
      }
    }
  });
}

/**
 * @template {object} T
 * @template {object} [TEventMap={}]
 * @overload
 * @param {T} data
 * @param {Array<EntityEffect<T & IEmitter<TEventMap>>>} [operators]
 * @return {T & IEmitter<TEventMap>}
 */

/**
 * @param {object} data
 * @param {Array<EntityEffect<unknown>>} [operators]
 * @return {object}
 */
function store(data, operators = []) {
  /** @type {Map<PropertyKey, () => unknown>} */
  const getters = new Map();
  /** @type {Map<PropertyKey, (value: unknown) => void>} */
  const setters = new Map();
  /**
   * The stores made here of the plain objects and arrays in `data`, which
   * this store owns.
   *
   * @type {Internals[]}
   */
  const made = [];
  /** @type {Record<PropertyKey, unknown>} */
  const state = withComputation(null, () => {
    const kind = storeKindOf(data);
    if (!kind) {
      throw new Error("Store can only be created from a plain object or an array");
    }
    const descriptors = describe(data);
    defineAccessors(getters, setters, descriptors);
    // A data key holds its value, a plain object or an array made a store,
    // and a store as itself. A key with an accessor holds `undefined`, which
    // is read only when the key has no getter; the getter is not run here.
    // `reshapeWith` keeps the same.
    /** @type {Record<PropertyKey, unknown>} */
    const held = kind === "array" ? /** @type {never} */ ([]) : {};
    for (const [key, descriptor] of descriptors) {
      const value = descriptor.get || descriptor.set ? undefined : descriptor.value;
      if (storeKindOf(value) && !isStore(value)) {
        const inner = store(/** @type {object} */ (value));
        made.push(/** @type {Internals} */ (internalsOf(inner)));
        held[key] = inner;
      } else {
        held[key] = value;
      }
    }
    if (Array.isArray(held)) {
      // The holes at its end are not keys, and only the length keeps them.
      held.length = /** @type {unknown[]} */ (data).length;
    }
    return held;
  });
  const array = Array.isArray(state);
  /** The state as an array, read only when `array` says it is one. */
  const elements = /** @type {unknown[]} */ (/** @type {unknown} */ (state));
  const ownKeys = Symbol("ownKeys");

  /** @type {Map<PropertyKey, Derived<unknown>>} */
  const derived = new Map();

  /**
   * What a reader of one key depends on: a counter per key, bumped when that
   * key is written.
   *
   * This used to be one `Subject` for the whole store and a
   * `pipe(filter(...))` per key on top of it, held behind a memoized
   * computation. The filtering was the point — a reader of `width` must not
   * wake for a write to `height` — and a signal per key does the same thing
   * by construction, without the stream.
   *
   * What that is worth is a matter of what a store is used for here. Every
   * mirrored element owns one (see `VisualProperties`), a panel owns a few
   * hundred elements, and each of those reads a dozen keys — so the old shape
   * cost a computation, a piped observable and a `skipSynchronousValues`
   * wrapper around it, per key per element, where this costs one signal. A
   * signal is also something `Computation` recognizes, so subscribing to it
   * touches no RxJS at all.
   *
   * Created on first read rather than up front: a key nobody reads reactively
   * needs nothing, and a write to one has nobody to tell.
   *
   * @type {Map<PropertyKey, Signal<number>>}
   */
  const versions = new Map();

  /**
   * @param {PropertyKey} key
   * @returns {Signal<number>}
   */
  const getChangesAtKey = (key) => {
    let version = versions.get(key);
    if (!version) {
      version = Signal.of(0);
      versions.set(key, version);
    }
    return version;
  };

  /**
   * Record a read of `key` in the running computation, unless it is the one
   * that called an array method running on the store. See `arrayMutators`.
   *
   * @param {PropertyKey} key
   * @returns {void}
   */
  const dependOn = (key) => {
    // Outside a computation there is nobody to record the read for, and
    // making the key's version would only cost the read an allocation.
    if (activeComputation && internals.mutator !== activeComputation) {
      addDependency(getChangesAtKey(key));
    }
  };

  /**
   * Record a read of the data key `key`, as `dependOn` does. On an array,
   * a key that is neither an index nor one of its own keys records a read
   * of the key set instead: it is a method such as `map`, or a key such as
   * `toJSON` or `Symbol.isConcatSpreadable` that a method looks for, and
   * whether the array has it is a fact about its key set, which a write
   * that adds the key announces. So no version is made per method name,
   * and a reader still hears when the program adds such a key. The price is
   * that `"map" in list` re-runs whenever a key is added, a `push` included.
   *
   * @param {PropertyKey} key
   * @returns {void}
   */
  const dependOnKey = (key) => {
    if (!array || isIndex(key) || Object.hasOwn(state, key)) {
      dependOn(key);
    } else {
      dependOn(ownKeys);
    }
  };

  /**
   * @param {PropertyKey} key
   * @returns {void}
   */
  const announce = (key) => {
    const version = versions.get(key);
    if (version) {
      bump(version);
    }
  };

  /** @type {Emitter<Record<PropertyKey, unknown>>} */
  const eventListener = new Emitter();
  const addEventListener = eventListener.addEventListener.bind(eventListener);
  const removeEventListener = eventListener.removeEventListener.bind(eventListener);

  /** @type {Internals} */
  const internals = {
    emitter: eventListener,
    state,
    array,
    getters,
    setters,
    derived,
    definition: undefined,
    announce,
    ownKeys,
    owner: null,
    mutator: undefined,
    held: 0,
    touched: null,
  };
  for (const inner of made) {
    inner.owner = internals;
    inner.held = 1;
  }

  const proxy = new Proxy(state, {
    get(_, key, receiver) {
      if (key === "addEventListener") {
        return addEventListener;
      }
      if (key === "removeEventListener") {
        return removeEventListener;
      }
      if (array) {
        const mutator = arrayMutators.get(key);
        if (mutator) {
          return mutator;
        }
      }
      dependOnKey(key);
      if (!getters.has(key)) {
        return state[key];
      }
      let signal = derived.get(key);
      if (!signal) {
        // The getter is looked up on each run rather than captured, so a
        // `reshape` that bumps `internals.definition` makes this run the
        // new one, and the cutoff spares the readers when it agrees.
        signal = new Derived(() => {
          (internals.definition ??= Signal.of(0)).get();
          const getter = getters.get(key);
          return getter ? getter.call(receiver) : state[key];
        });
        derived.set(key, signal);
      }
      return signal.get();
    },
    set(_, key, newValue, receiver) {
      const setter = setters.get(key);
      if (setter) {
        setter.call(receiver, newValue);
      } else if (getters.has(key)) {
        // A getter with no setter is readonly, which the store's type says
        // too. The write does nothing, as on a frozen object outside strict
        // mode, rather than land in `state`, which a getter key is not read
        // from.
      } else if (array && key === "length") {
        const length = elements.length;
        const target = Number(newValue);
        const removed = target < length ? elements.slice(target) : [];
        // Assigned first, so that a length that is not one throws as on an
        // array, before anything is marked or counted.
        elements.length = /** @type {number} */ (newValue);
        const next = elements.length;
        if (next === length) {
          return true;
        }
        for (const value of removed) {
          countHolder(internals, value, -1);
        }
        internals.touched?.add(key);
        batch(() => {
          // The indices a shorter length cut off are gone, as by `delete`.
          for (let index = next; index < length; index += 1) {
            announce(String(index));
          }
          announce(key);
          if (next < length) {
            announce(ownKeys);
          }
        });
      } else {
        const kind = storeKindOf(newValue);
        if (kind) {
          const oldValue = state[key];
          const nested = internalsOf(oldValue);
          if (
            nested?.owner === internals &&
            isOfKind(nested, kind) &&
            !isStore(newValue) &&
            internals.mutator === undefined &&
            nested.held === 1 &&
            !placing?.has(oldValue)
          ) {
            // Written into the nested store this one owns key by key, whose
            // traps mark the keys the value changes. This key holds the same
            // store as before, so it is not marked, as no unchanged key is. A
            // store from elsewhere is its owner's, and one this store also
            // holds at another key is that key's too, so for either the value
            // makes a new store here, as on a reload.
            replace(
              /** @type {Record<PropertyKey, unknown>} */ (oldValue),
              /** @type {Record<PropertyKey, unknown>} */ (newValue),
            );
            return true;
          }
          // A store is held as itself, so that an array method moving one
          // from index to index moves it rather than copying it, and keeps
          // its owner. A plain object or an array where the key held no
          // store of its kind that this one owns is made one, which is new
          // and this store's, and every key of it is a change the program
          // made.
          if (!isStore(newValue)) {
            newValue = nestedStore(internals, /** @type {object} */ (newValue), true);
          }
        }
        // On an array, `undefined` at an index it does not have is a change:
        // it makes the index, as a native write does. An object key an
        // assigned object holds `undefined` for is not made, as before.
        if (Object.is(state[key], newValue) && (!array || Object.hasOwn(state, key))) {
          return true;
        }
        // A write the program makes that changes a data key, which `reshape`
        // keeps. One that changes nothing marks nothing, so a value written
        // back to itself still follows the source.
        internals.touched?.add(key);
        const length = array ? elements.length : 0;
        countHolder(internals, state[key], -1);
        state[key] = newValue;
        countHolder(internals, newValue, 1);
        // One write is one update. Announcing a change queues each dependent,
        // and outside a batch a queued dependent drains immediately — so
        // without this the `ownKeys` readers would not be told until the
        // key's own readers had already recomputed, and a computation reading
        // both would see the store halfway through the write. See
        // `ReactiveMap#notify`.
        batch(() => {
          announce(key);
          if (array && elements.length !== length) {
            // An index at or past the end moved the length with it.
            announce("length");
          }
          announce(ownKeys);
        });
      }
      return true;
    },
    has(_, key) {
      dependOnKey(key);
      return key in state;
    },
    getOwnPropertyDescriptor(_, key) {
      // What `Object.hasOwn` and a spread ask of each key, so that their
      // reader follows the key as `in` does.
      dependOnKey(key);
      return Reflect.getOwnPropertyDescriptor(state, key);
    },
    defineProperty() {
      // A key of a store changes through its traps alone, which tell its
      // readers, mark it for `reshape` and keep `Internals.held`. A define
      // would bypass all three, so it is refused, and `Object.defineProperty`
      // throws, in sloppy code too.
      return false;
    },
    preventExtensions() {
      // Refused too, so that `Object.preventExtensions`, `seal` and `freeze`
      // throw before they touch `state`, which would otherwise refuse every
      // later write of a new key, a `push` included.
      return false;
    },
    deleteProperty(_, key) {
      if (getters.has(key) || setters.has(key)) {
        // A key with a getter or a setter stays for the store's life, since
        // only `reshape` changes those. The delete does nothing, as on a
        // non-configurable property outside strict mode.
        return true;
      }
      if (Object.hasOwn(state, key)) {
        // A delete the program makes that removes a key, which `reshape`
        // keeps as it keeps a write. One of a key the store does not have
        // marks nothing, so the source can still add the key.
        internals.touched?.add(key);
        countHolder(internals, state[key], -1);
      }
      delete state[key];
      batch(() => {
        announce(key);
        announce(ownKeys);
      });
      return true;
    },
    ownKeys() {
      dependOn(ownKeys);
      return Reflect.ownKeys(state);
    },
  });
  new Brand(proxy, internals);

  if (operators.length > 0) {
    // Skipped when there is nothing to apply, which is the common case: a
    // store is the ordinary way to hold state here and most hold it without
    // piping the entity through anything. `useEffects([])` is not free -- it
    // builds an `Observable`, a `ReplaySubject` and a `share`, subscribes
    // them, and registers a dependency that can never fire, once per store.
    useEffects(proxy, operators);
  }
  return proxy;
}

/**
 * Record the keys the program writes to `target`, so that `reshape` keeps
 * them. From this call on, a write through the store's proxy that changes a
 * data key, or a delete that removes one, marks the key as the program's,
 * and so does one through a store it owns, now or later. A reload then
 * takes the definition's side for every other key. Nothing is recorded
 * before the call, and nothing for a store nobody calls it on, so a store
 * that is never reloaded pays one null check per write and no more. A
 * second call changes nothing, on the store or on a store nested in it that
 * was tracked first.
 *
 * `@apendua/vite-hmr` calls it on every store a module exports, once the
 * export's initialiser has evaluated. A write to a key with a getter or a
 * setter is not state and marks nothing. A write that changes nothing, or a
 * delete of a key the store does not have, marks nothing. A write marks the
 * keys whose value it changes, at whatever depth: a plain object or an array
 * assigned to a key that held no store of its kind becomes a new store, every
 * key of which is a change, and one assigned over a store of its kind the key
 * owns, and holds at no other key, is written into it key by key and marks the
 * keys it changes there, not the key it sits at, which holds the same store. A
 * store assigned to a key is held as itself and marks the key, and stays its
 * owner's: a reload never reshapes it through that key, and a plain object or
 * an array assigned over it makes a new store. An array is a store, so a method
 * that changes it, a `push` or a `splice`, writes through it and marks what it
 * changes. A reload records nothing, since `reshape` writes state directly
 * rather than through the proxy, and clears the mark of a key it gives an
 * accessor to.
 *
 * Only a write through the store is seen. A value the program mutates in
 * place, a `Map` or a `Set` it fills, an instance whose field it sets, marks
 * nothing, and a reload replaces it with the definition's. State that has to
 * survive a reload goes in a plain object or an array, which is a store and
 * tracked, or in a `ReactiveMap` or `ReactiveSet` export of its own, which
 * is kept as state.
 *
 * @template {IEmitter<Record<any, any>>} T
 * @param {T} target A store.
 * @returns {void}
 */
export function trackWrites(target) {
  const internals = internalsOf(target);
  if (!internals) {
    throw new Error("trackWrites() takes a store");
  }
  track(internals, false);
}

/**
 * Start recording the program's writes to a store and to every store it
 * owns, at any depth. A store it holds and does not own records by its
 * owner. `owned` marks every data key as written already: for a store made
 * of an object the program assigned where no store was, every key of which
 * is a change. A store already recording keeps its marks, and so do the
 * stores it owns, which it reached when it started; an owned store is
 * freshly built and never already recording.
 *
 * @param {Internals} internals
 * @param {boolean} owned
 */
function track(internals, owned) {
  if (internals.touched) {
    return;
  }
  const { state, getters, setters } = internals;
  const keys = Reflect.ownKeys(state);
  internals.touched = new Set(
    owned ? keys.filter((key) => !getters.has(key) && !setters.has(key)) : [],
  );
  for (const key of keys) {
    const nested = internalsOf(state[key]);
    if (nested?.owner === internals) {
      track(nested, owned);
    }
  }
}

/**
 * A store made of `value` to nest in `internals`' store, which owns it,
 * recording the program's writes if that one does: as the program's own
 * when it assigned the value, with every key marked, and as the source's
 * otherwise.
 *
 * @param {Internals} internals
 * @param {object} value A plain object or an array.
 * @param {boolean} owned
 * @returns {object}
 */
function nestedStore(internals, value, owned) {
  const inner = store(value);
  const nested = /** @type {Internals} */ (internalsOf(inner));
  nested.owner = internals;
  if (internals.touched) {
    track(nested, owned);
  }
  return inner;
}

/**
 * What a reload puts at a key of `internals`' store for the definition's
 * `value`, a plain object, an array or a store, where the key holds no
 * store of its own of that kind. A plain object or an array is made a store
 * the key owns. A store the definition `from` owns becomes this store's
 * once the reload is done, since the definition is dropped then. Until
 * then it is the definition's at every key of the pass, so a key where the
 * program already holds it is a store from elsewhere there and is left
 * alone, whichever key the definition lists first. Any other store, one
 * made by a call to `store()` or one another store owns, is held as itself
 * and stays its owner's.
 *
 * @param {Internals} internals
 * @param {object} value
 * @param {Internals | undefined} from The definition's record, when the
 *   definition is a store.
 * @param {Set<Internals>} adopted The stores the reload is taking over,
 *   which `countAdopted` re-owns and counts when it is done.
 * @returns {object}
 */
function adopt(internals, value, from, adopted) {
  const nested = internalsOf(value);
  if (!nested) {
    return nestedStore(internals, value, false);
  }
  if (from && nested.owner === from) {
    // Re-owned and counted by `countAdopted` once the reload has written
    // every key, so that the store is the definition's at every key of the
    // pass, whatever their order.
    adopted.add(nested);
    if (internals.touched) {
      track(nested, false);
    }
  }
  return value;
}

/**
 * Give `target` what `definition` defines, except for the keys the program has
 * written. Its getters and setters are the definition's. A key the program has
 * not touched takes the definition's side in full, its value or its absence, so
 * an edit to an initial value in source shows on a reload. The exception is a
 * key of an array store that is not an index, which a reload leaves as it is;
 * see `reshapeArray`. A data key the program wrote or deleted since
 * `trackWrites` keeps what the program did: its value stays, a key the program
 * added stays, and a key the program deleted stays deleted, whatever the
 * definition says, until the definition gives the key a getter or a setter.
 * That wins as a change of shape and clears the mark, so the key takes the
 * definition's value if it becomes a data key again. A nested store the key
 * owns, one made there of a plain object or an array, is reshaped the same way
 * in place, by its own marks, with the plain object or the array at its key. A
 * write into it marks its own key and not the key it sits at, so that key is
 * the source's: when the definition drops it or makes it a value of another
 * kind, the nested store goes, the program's writes into it with it. A store
 * this one owns that the program also holds at a second key is reshaped through
 * each key in turn, so the later key's definition is what it ends with. A store
 * the program assigned to the key from elsewhere is held as itself and is not
 * the key's: the key is the program's, as a key it assigned a value to is, and
 * the store is reshaped only through its owner. An array store keeps which
 * element is at each index, and its length, once the program has written to it,
 * and takes the definition's elements otherwise, while the element stores it
 * owns are reshaped in place either way; see `reshapeArray`. A value that is
 * not a plain object or an array, a `Map`, an instance, is kept only at a key
 * the program assigned; one the program mutated in place is untouched to the
 * store and takes the definition's. A store nobody called `trackWrites` on has
 * no marks and takes the definition in full.
 *
 * A data key's value is written to the store's state, not through a setter,
 * so no setter runs. The readers of each key that changed re-run; a replaced
 * getter's readers re-run only when its value changes by `Object.is`, so a
 * getter that builds a new object on each call re-runs them on every
 * reshape. A kept key re-runs nobody.
 *
 * `definition` is a plain object, or a store, which stands for its getters and
 * setters and the values it holds now. A store the definition holds at a key,
 * one it owns, is taken over as itself: after the reload the key holds that
 * very store, and it is this store's. It becomes so once the reload is done, so
 * a key where the program already holds it is left alone on this reload, as a
 * key holding a store from elsewhere is, and reshaped through on the next. For
 * a store made of an array it is an array, or an array store. A store keeps the
 * kind it was made with, so a definition of the other kind throws, and for an
 * array store its type refuses one too. This is the whole of a hot reload of a
 * store; `replace` is an assignment and belongs to the running program.
 *
 * A key with a setter and no getter reads `undefined`, as it does when
 * `store()` makes it: a write to it goes to the setter, never to `state`.
 * Like a key with a getter, it stays for the store's life: `delete` does not
 * remove it. A store is given no key named `__proto__` or `constructor`:
 * the first sets a plain object's prototype, the second is how
 * `isPlainObject` tells a plain object.
 *
 * @template {IEmitter<Record<any, any>>} T
 * @param {T} target A store.
 * @param {T extends readonly unknown[] ? readonly unknown[] : object}
 *   definition An array for a store made of one, which its type refuses
 *   anything else for. The type cannot refuse an array for a store made of an
 *   object, since an array is an object, so that throws.
 * @returns {void}
 */
export function reshape(target, definition) {
  const internals = internalsOf(target);
  if (!internals) {
    throw new Error("reshape() takes a store");
  }
  if (internals.array !== Array.isArray(definition)) {
    throw new Error("reshape() takes a definition of the store's kind");
  }
  batch(() => {
    reshapeInto(internals, definition);
  });
}

/**
 * Reshape the store of `internals` with `definition`, which is of its kind.
 *
 * @param {Internals} internals
 * @param {object} definition
 */
function reshapeInto(internals, definition) {
  if (internals.array) {
    reshapeArray(internals, /** @type {unknown[]} */ (definition));
  } else {
    reshapeWith(internals, describe(definition), internalsOf(definition));
  }
}

/**
 * Reshape `held`, what a key of `internals`' store holds, in place with the
 * definition's `value`, if it is a store `internals` owns and `value` is of its
 * kind. A store held at two keys or two indices is reshaped once for each, with
 * the definition's value at each in turn, so the one at the later key is what
 * it ends with. An assignment through either key makes a new store instead, and
 * the two differ on purpose: an assignment is the program giving one key a new
 * value, which must not show at the other, while a reload keeps what the
 * program holds, its aliases included, and only edits what is inside it.
 *
 * @param {Internals} internals
 * @param {unknown} held
 * @param {unknown} value
 * @returns {boolean} Whether it reshaped `held`.
 */
function reshapeOwned(internals, held, value) {
  const nested = internalsOf(held);
  if (nested?.owner !== internals || !isOfKind(nested, storeKindOf(value))) {
    return false;
  }
  reshapeInto(nested, /** @type {object} */ (value));
  return true;
}

/**
 * Give the data key `key` of `internals`' store the definition's `value`. A
 * store the key owns, where `value` is of its kind, is reshaped in place by
 * its own marks, whoever wrote the key it sits at. Otherwise a key the
 * program marked keeps what the program did, and an unmarked one takes the
 * value, made a store the key owns when it is a plain object or an array.
 * Only the readers of a key whose value changed re-run.
 *
 * @param {Internals} internals
 * @param {PropertyKey} key
 * @param {unknown} value
 * @param {Internals | undefined} from The definition's record, when the
 *   definition is a store.
 * @param {Set<Internals>} adopted See `adopt`.
 */
function reshapeKey(internals, key, value, from, adopted) {
  const { state, announce, ownKeys, touched } = internals;
  const had = Object.hasOwn(state, key);
  const old = state[key];
  if (reshapeOwned(internals, old, value)) {
    return;
  }
  if (touched?.has(key)) {
    // The program wrote or deleted this key: what it did stays.
    return;
  }
  const next = storeKindOf(value)
    ? adopt(internals, /** @type {object} */ (value), from, adopted)
    : value;
  if (had && Object.is(old, next)) {
    return;
  }
  countHolder(internals, old, -1);
  state[key] = next;
  countHolder(internals, next, 1);
  announce(key);
  if (!had) {
    announce(ownKeys);
  }
}

/**
 * The descriptors `definition` defines a store with. A store stands for its
 * getters and setters and the values it holds now, so that what has been
 * written to it since it was made is kept. A plain object gives its
 * enumerable keys, the ones a spread copies.
 *
 * @param {object} definition
 * @returns {Descriptors}
 */
function describe(definition) {
  /** @type {Descriptors} */
  const descriptors = new Map();
  const internals = internalsOf(definition);
  if (!internals) {
    // The keys a spread would copy: the enumerable ones, in the order of
    // `Reflect.ownKeys`. `Object.keys` lists the strings from V8's enum
    // cache, where `Reflect.ownKeys` builds a fresh list each call and was
    // the larger part of making a small store.
    for (const key of Object.keys(definition)) {
      descriptors.set(
        key,
        /** @type {PropertyDescriptor} */ (Reflect.getOwnPropertyDescriptor(definition, key)),
      );
    }
    for (const key of Object.getOwnPropertySymbols(definition)) {
      const descriptor = /** @type {PropertyDescriptor} */ (
        Reflect.getOwnPropertyDescriptor(definition, key)
      );
      if (descriptor.enumerable) {
        descriptors.set(key, descriptor);
      }
    }
    return descriptors;
  }
  for (const key of Reflect.ownKeys(internals.state)) {
    const get = internals.getters.get(key);
    const set = internals.setters.get(key);
    descriptors.set(
      key,
      get || set
        ? { get, set, enumerable: true, configurable: true }
        : { value: internals.state[key], writable: true, enumerable: true, configurable: true },
    );
  }
  return descriptors;
}

/**
 * Fill `getters` and `setters` from `descriptors`.
 *
 * @param {Map<PropertyKey, () => unknown>} getters
 * @param {Map<PropertyKey, (value: unknown) => void>} setters
 * @param {Descriptors} descriptors
 */
function defineAccessors(getters, setters, descriptors) {
  for (const [key, descriptor] of descriptors) {
    if (descriptor.get) {
      getters.set(key, descriptor.get);
    }
    if (descriptor.set) {
      setters.set(key, descriptor.set);
    }
  }
}

/**
 * @param {Internals} internals
 * @param {Descriptors} descriptors
 * @param {Internals | undefined} from The definition's record, when the
 *   definition is a store.
 */
function reshapeWith(internals, descriptors, from) {
  const { state, getters, setters, derived, announce, ownKeys, touched } = internals;
  /** @type {Set<Internals>} */
  const adopted = new Set();
  const previous = new Map(getters);
  getters.clear();
  setters.clear();
  defineAccessors(getters, setters, descriptors);
  // A getter replaced by another: its `Derived` recomputes and the cutoff
  // decides whether its readers re-run. A key that gains or loses its getter
  // changes where it is read from, so its readers re-run.
  let replaced = false;
  for (const key of new Set([...previous.keys(), ...getters.keys()])) {
    const before = previous.get(key);
    const after = getters.get(key);
    if (before === after) {
      continue;
    }
    if (before && after) {
      replaced = true;
      continue;
    }
    derived.delete(key);
    announce(key);
  }
  if (replaced && internals.definition) {
    bump(internals.definition);
  }
  // The values of the data keys, written to `state` rather than through the
  // store, so no setter runs.
  for (const [key, descriptor] of descriptors) {
    if (descriptor.get || descriptor.set) {
      // A key with an accessor is in `state` as a key holding `undefined`,
      // as at `store()` time, so `in`, `ownKeys` and spread see it, and a
      // value it held as a data key is let go of, the program's or not: the
      // shape wins, and the key is the source's again.
      touched?.delete(key);
      const added = !Object.hasOwn(state, key);
      if (added || state[key] !== undefined) {
        countHolder(internals, state[key], -1);
        state[key] = undefined;
        announce(key);
      }
      if (added) {
        announce(ownKeys);
      }
      continue;
    }
    reshapeKey(internals, key, descriptor.value, from, adopted);
  }
  // The keys the definition no longer has, unless the program put them there.
  for (const key of Reflect.ownKeys(state)) {
    if (!descriptors.has(key) && !touched?.has(key)) {
      countHolder(internals, state[key], -1);
      delete state[key];
      derived.delete(key);
      announce(key);
      announce(ownKeys);
    }
  }
  countAdopted(internals, adopted);
}

/**
 * Make the stores a reload adopted this store's, and set their `held` in
 * one pass over the keys of `internals`' state, once the reload has written
 * and dropped every key: a key a program assignment made may hold one
 * already, and a count kept per adoption would walk the state once per
 * store.
 *
 * @param {Internals} internals
 * @param {Set<Internals>} adopted
 */
function countAdopted(internals, adopted) {
  if (adopted.size === 0) {
    return;
  }
  for (const nested of adopted) {
    nested.owner = internals;
    nested.held = 0;
  }
  const { state } = internals;
  for (const key of Reflect.ownKeys(state)) {
    const nested = internalsOf(state[key]);
    if (nested && adopted.has(nested)) {
      nested.held += 1;
    }
  }
}

/**
 * Give the array store of `internals` the elements of `definition`, an array
 * or an array store, unless the program has written to it.
 *
 * Which element the array holds at each index, and its length, are the
 * program's or the source's as a whole, not index by index: its indices are
 * positions, not names, and a `shift` or a `splice` moves what each holds, so a
 * mark on an index says nothing about the element now at it. A write the
 * program makes to the array, to any of its keys, an index, its length or
 * another, by assignment or by any of its methods, keeps which element is at
 * each index and the length as the program left them. A write into a store the
 * array holds marks that store and not the array, as it would at a key of an
 * object.
 *
 * What is inside an element store the array owns follows the source either way.
 * Such an element, where the definition has a plain object or an array of its
 * kind at the same index, is reshaped in place by its own marks, so that a
 * getter edited in source reaches it and the program's writes into it stay. In
 * an array the program has written to, the element at an index may have come
 * from another index, and is reshaped with the definition's at the index it is
 * at now. A store at two indices, after a `copyWithin`, is reshaped with the
 * definition's element at each in turn, so the one at the later index is what
 * it ends with. An element store the array does not own, one the program moved
 * in from another array, is its owner's, and the array does not reshape it.
 *
 * An array the program has not written takes the definition's elements and
 * length. Its keys that are not indices, a `meta` the program set or one the
 * array was made with, are left as they are either way, getters and setters
 * included: a reload reads the definition's indices and length alone. Every
 * element that is not reshaped in place takes the definition's, and only the
 * readers of an index whose element changed, and of the length when it did,
 * re-run.
 *
 * @param {Internals} internals
 * @param {unknown[]} definition
 */
function reshapeArray(internals, definition) {
  const { state, announce, ownKeys, touched } = internals;
  const array = /** @type {unknown[]} */ (/** @type {unknown} */ (state));
  const from = internalsOf(definition);
  const source = /** @type {unknown[]} */ (from?.state ?? definition);
  if (touched?.size) {
    // The program's elements stay where it put them. Only what is inside
    // the ones this array owns follows the source.
    const shared = Math.min(array.length, source.length);
    for (let index = 0; index < shared; index += 1) {
      reshapeOwned(internals, array[index], source[index]);
    }
    return;
  }
  const before = array.length;
  /** @type {Set<Internals>} */
  const adopted = new Set();
  for (let index = 0; index < source.length; index += 1) {
    const key = String(index);
    const had = Object.hasOwn(array, index);
    if (!Object.hasOwn(source, index)) {
      // A hole in the definition is one in the store.
      if (had) {
        countHolder(internals, array[index], -1);
        delete array[index];
        announce(key);
        announce(ownKeys);
      }
      continue;
    }
    reshapeKey(internals, key, source[index], from, adopted);
  }
  for (let index = source.length; index < array.length; index += 1) {
    countHolder(internals, array[index], -1);
    announce(String(index));
  }
  array.length = source.length;
  if (array.length !== before) {
    announce("length");
    announce(ownKeys);
  }
  countAdopted(internals, adopted);
}

export default store;
