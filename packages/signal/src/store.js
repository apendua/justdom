import { addDependency, withComputation } from "./core.js";
import { Derived } from "./Derived.js";
import { Signal } from "./Signal.js";
import { batch } from "./scheduler.js";
import Emitter from "./Emitter.js";
import { useEffects } from "./operators.js";
import { isPlainObject } from "./util.js";

/**
 * @import {EntityEffect} from "./types.js"
 * @import {IEmitter} from "./Emitter.js";
 */

/**
 * @typedef {object} Internals
 * @property {Emitter<Record<PropertyKey, unknown>>} emitter
 * @property {Record<PropertyKey, unknown>} state An array for a store made
 *   of one, a plain object otherwise.
 * @property {boolean} array Whether `state` is an array. A store keeps the
 *   kind it was made with.
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
 * @property {number} mutating How many of the array methods in
 *   `arrayMutators` are running on the store. See there for what it changes.
 * @property {Set<PropertyKey> | null} touched The data keys the program has
 *   written or deleted through the proxy since `trackWrites` was called,
 *   which `reshape` keeps. `null` until then, so a store nobody reloads
 *   records nothing.
 */

/**
 * Every proxy `store()` has made. `internalsOf` asks this before it reads a
 * key of the value it was given, since reading a key of a proxy runs its
 * `get` trap: a `selector()` evaluates its source for any key, and throws
 * for a source that is not ready. Membership reads nothing, and an object
 * whose prototype is a store is not a member.
 *
 * @type {WeakSet<object>}
 */
const stores = new WeakSet();

/**
 * The key a store's proxy answers with its `Internals`, which `emit`,
 * `reshape` and a store used as another's definition read. It is not one
 * of the store's keys: `in`, `ownKeys` and spread do not see it. A
 * `WeakMap` from proxy to record did the same job, and holding every store's
 * record in it made building a store about a fifth slower; `stores` holds
 * the proxy alone.
 */
const internalsKey = Symbol("internals");

/**
 * @param {unknown} value
 * @returns {Internals | undefined} The record of `value` if it is a store.
 */
function internalsOf(value) {
  if (typeof value !== "object" || value === null || !stores.has(value)) {
    return undefined;
  }
  return /** @type {{ [internalsKey]: Internals }} */ (value)[internalsKey];
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
 * The array methods that change the array they are called on, each run on
 * the store as one batch with the store's `mutating` count raised. The
 * method itself is the native one, called on the proxy, so every key it
 * reads and writes goes through the store's traps.
 *
 * One batch, because a method writes several keys, an index or two and
 * `length` for a `push`, every index for a `sort`, and a reader of more than
 * one must see the array once it is done rather than once per key.
 *
 * While `mutating` is raised, the store's traps record no read of its own
 * keys, since each method reads the array it writes, its `length` at least,
 * and an `Effect` that pushes would otherwise depend on the `length` it
 * writes and run again on its own push. A read of anything else, a `sort`
 * comparator's read of an element store, is recorded as any read is, so an
 * effect that sorts follows what it sorts by. And a value written while it
 * is raised always makes a new store at its index, never a write into the
 * store found there: `unshift` and `splice` copy an element up before they
 * write the index it came from, so that store is the one now held one index
 * on.
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
    const internals = /** @type {Internals} */ (internalsOf(this));
    // Lowered inside the batch, before it drains: an effect the method
    // queued re-runs after it, and its reads of the store are its own.
    return batch(() => {
      internals.mutating += 1;
      try {
        return method.apply(this, args);
      } finally {
        internals.mutating -= 1;
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
 * go. Each index is assigned as a key is, so a plain object or an array
 * written over a store of its kind at the same index is written into that
 * store, and the store stays where it is.
 *
 * @param {Record<PropertyKey, unknown> | unknown[]} oldValue
 * @param {Record<PropertyKey, unknown> | unknown[]} newValue
 */
export function replace(oldValue, newValue) {
  batch(() => {
    Object.assign(oldValue, newValue);
    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      oldValue.length = newValue.length;
    }
    for (const k of ownKeysNoComputation(oldValue)) {
      if (!Reflect.has(newValue, k)) {
        delete (/** @type {Record<PropertyKey, unknown>} */ (oldValue)[k]);
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
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      const value = descriptor.get || descriptor.set ? undefined : descriptor.value;
      held[key] = storeKindOf(value) ? asStore(value) : value;
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
   * Record a read of `key` in the running computation, unless one of the
   * store's own array methods made it. See `arrayMutators`.
   *
   * @param {PropertyKey} key
   * @returns {void}
   */
  const dependOn = (key) => {
    if (internals.mutating === 0) {
      addDependency(getChangesAtKey(key));
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
    mutating: 0,
    touched: null,
  };

  const proxy = new Proxy(state, {
    get(_, key, receiver) {
      if (key === "addEventListener") {
        return addEventListener;
      }
      if (key === "removeEventListener") {
        return removeEventListener;
      }
      if (key === internalsKey) {
        return internals;
      }
      if (array) {
        const mutator = arrayMutators.get(key);
        if (mutator) {
          return mutator;
        }
      }
      dependOn(key);
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
        // Assigned first, so that a length that is not one throws as on an
        // array, before anything is marked.
        elements.length = /** @type {number} */ (newValue);
        const next = elements.length;
        if (next === length) {
          return true;
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
          if (nested && isOfKind(nested, kind) && !isStore(newValue) && internals.mutating === 0) {
            // Written into the nested store key by key, whose traps mark the
            // keys the value changes. This key holds the same store as
            // before, so it is not marked, as no unchanged key is.
            replace(
              /** @type {Record<PropertyKey, unknown>} */ (oldValue),
              /** @type {Record<PropertyKey, unknown>} */ (newValue),
            );
            return true;
          }
          // A store is held as itself, so that an array method moving one
          // from index to index moves it rather than copying it. A plain
          // object or an array where the key held no store of its kind is
          // made one, which is new, and every key of it is a change the
          // program made.
          if (!Object.is(oldValue, newValue)) {
            newValue = nestedStore(internals, /** @type {object} */ (newValue), true);
          }
        }
        if (Object.is(state[key], newValue)) {
          return true;
        }
        // A write the program makes that changes a data key, which `reshape`
        // keeps. One that changes nothing marks nothing, so a value written
        // back to itself still follows the source.
        internals.touched?.add(key);
        const length = array ? elements.length : 0;
        state[key] = newValue;
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
      dependOn(key);
      return key in state;
    },
    getOwnPropertyDescriptor(_, key) {
      // What `Object.hasOwn` and a spread ask of each key, so that their
      // reader follows the key as `in` does.
      dependOn(key);
      return Reflect.getOwnPropertyDescriptor(state, key);
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
  stores.add(proxy);

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
 * and so does one through a store nested in it, now or later. A reload then
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
 * keys whose value it changes, at whatever depth: a plain object or an
 * array assigned to a key that held no store of its kind becomes a new
 * store, every key of which is a change, and one assigned over a nested
 * store of its kind is written into it key by key and marks the keys it
 * changes there, not the key it sits at, which holds the same store. A
 * store assigned to a key is held as itself and marks the key. An array is
 * a store, so a method that changes it, a `push` or a `splice`, writes
 * through it and marks what it changes. A reload records nothing, since
 * `reshape` writes state directly rather than through the proxy, and clears
 * the mark of a key it gives an accessor to.
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
 * Start recording the program's writes to a store and to every store nested
 * in it. `owned` marks every data key as written already: for a store made
 * of an object the program assigned where no store was, every key of which
 * is a change. A store already recording keeps its marks, and so do the
 * stores nested in it, which it reached when it started; an owned store is
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
    if (nested) {
      track(nested, owned);
    }
  }
}

/**
 * `value` if it is a store, and a store made of it otherwise.
 *
 * @param {object} value A store, a plain object or an array.
 * @returns {object}
 */
function asStore(value) {
  return isStore(value) ? value : store(value);
}

/**
 * The store to nest in `internals`' store for `value`, recording the
 * program's writes if that one does: as the program's own when it assigned
 * the value, with every key marked, and as the source's otherwise. A store
 * is nested as itself, and keeps its marks if it has them.
 *
 * @param {Internals} internals
 * @param {object} value A store, a plain object or an array.
 * @param {boolean} owned
 * @returns {object}
 */
function nestedStore(internals, value, owned) {
  const inner = asStore(value);
  if (internals.touched) {
    track(/** @type {Internals} */ (internalsOf(inner)), owned);
  }
  return inner;
}

/**
 * Give `target` what `definition` defines, except for the keys the program
 * has written. Its getters and setters are the definition's. A key the
 * program has not touched takes the definition's side in full, its value or
 * its absence, so an edit to an initial value in source shows on a reload. A
 * data key the program wrote or deleted since `trackWrites` keeps what the
 * program did: its value stays, a key the program added stays, and a key the
 * program deleted stays deleted, whatever the definition says, until the
 * definition gives the key a getter or a setter. That wins as a change of
 * shape and clears the mark, so the key takes the definition's value if it
 * becomes a data key again. A nested store is reshaped the same way in
 * place, by its own marks, with the plain object or the array at its key.
 * A write into it marks its own key and not the key it sits at, so that key
 * is the source's: when the definition drops it or makes it a value of
 * another kind, the nested store goes, the program's writes into it with
 * it. An array store keeps which element is at each index, and its length,
 * once the program has written to it, and takes the definition's elements
 * otherwise, while its element stores are reshaped in place either way; see
 * `reshapeArray`. A value that is not a plain object or an array, a `Map`,
 * an instance, is kept only at a key the program assigned; one the program
 * mutated in place is untouched to the store and takes the definition's. A
 * store nobody called `trackWrites` on has no marks and takes the
 * definition in full.
 *
 * A data key's value is written to the store's state, not through a setter,
 * so no setter runs. The readers of each key that changed re-run; a replaced
 * getter's readers re-run only when its value changes by `Object.is`, so a
 * getter that builds a new object on each call re-runs them on every
 * reshape. A kept key re-runs nobody.
 *
 * `definition` is a plain object, or a store, which stands for its getters
 * and setters and the values it holds now. For a store made of an array it
 * is an array, or an array store. A store keeps the kind it was made with,
 * so a definition of the other kind throws, and for an array store its type
 * refuses one too. This is the whole of a hot reload
 * of a store; `replace` is an assignment and belongs to the running program.
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
 * @param {T extends readonly unknown[] ? readonly unknown[] : object} definition
 *   An array for a store made of one, which its type refuses anything else
 *   for. The type cannot refuse an array for a store made of an object,
 *   since an array is an object, so that throws.
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
    reshapeWith(internals, describe(definition));
  }
}

/**
 * The descriptors `definition` defines a store with. A store stands for its
 * getters and setters and the values it holds now, so that what has been
 * written to it since it was made is kept. A plain object gives its
 * enumerable keys, the ones a spread copies.
 *
 * @param {object} definition
 * @returns {Record<PropertyKey, PropertyDescriptor>}
 */
function describe(definition) {
  const internals = internalsOf(definition);
  if (!internals) {
    // The keys a spread would copy: the enumerable ones.
    /** @type {Record<PropertyKey, PropertyDescriptor>} */
    const descriptors = Object.getOwnPropertyDescriptors(definition);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (!descriptors[key].enumerable) {
        delete descriptors[key];
      }
    }
    return descriptors;
  }
  /** @type {Record<PropertyKey, PropertyDescriptor>} */
  const descriptors = {};
  for (const key of Reflect.ownKeys(internals.state)) {
    const get = internals.getters.get(key);
    const set = internals.setters.get(key);
    descriptors[key] =
      get || set
        ? { get, set, enumerable: true, configurable: true }
        : { value: internals.state[key], writable: true, enumerable: true, configurable: true };
  }
  return descriptors;
}

/**
 * Fill `getters` and `setters` from `descriptors`.
 *
 * @param {Map<PropertyKey, () => unknown>} getters
 * @param {Map<PropertyKey, (value: unknown) => void>} setters
 * @param {Record<PropertyKey, PropertyDescriptor>} descriptors
 */
function defineAccessors(getters, setters, descriptors) {
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
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
 * @param {Record<PropertyKey, PropertyDescriptor>} descriptors
 */
function reshapeWith(internals, descriptors) {
  const { state, getters, setters, derived, announce, ownKeys, touched } = internals;
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
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor.get || descriptor.set) {
      // A key with an accessor is in `state` as a key holding `undefined`,
      // as at `store()` time, so `in`, `ownKeys` and spread see it, and a
      // value it held as a data key is let go of, the program's or not: the
      // shape wins, and the key is the source's again.
      touched?.delete(key);
      const added = !Object.hasOwn(state, key);
      if (added || state[key] !== undefined) {
        state[key] = undefined;
        announce(key);
      }
      if (added) {
        announce(ownKeys);
      }
      continue;
    }
    const value = descriptor.value;
    const added = !Object.hasOwn(state, key);
    const old = state[key];
    const nested = internalsOf(old);
    const kind = storeKindOf(value);
    if (nested && isOfKind(nested, kind)) {
      // By the nested store's own marks, whoever wrote the key it sits at.
      reshapeInto(nested, value);
      continue;
    }
    if (touched?.has(key)) {
      // The program wrote or deleted this key: what it did stays.
      continue;
    }
    const next = kind ? nestedStore(internals, value, false) : value;
    if (!added && Object.is(old, next)) {
      continue;
    }
    state[key] = next;
    announce(key);
    if (added) {
      announce(ownKeys);
    }
  }
  // The keys the definition no longer has, unless the program put them there.
  for (const key of Reflect.ownKeys(state)) {
    if (!Object.hasOwn(descriptors, key) && !touched?.has(key)) {
      delete state[key];
      derived.delete(key);
      announce(key);
      announce(ownKeys);
    }
  }
}

/**
 * Give the array store of `internals` the elements of `definition`, an array
 * or an array store, unless the program has written to it.
 *
 * Which element the array holds at each index, and its length, are the
 * program's or the source's as a whole, not index by index: its indices are
 * positions, not names, and a `shift` or a `splice` moves what each holds,
 * so a mark on an index says nothing about the element now at it. A write
 * the program makes to the array, to an index or to its length, by
 * assignment or by any of its methods, keeps which element is at each index
 * and the length as the program left them. A write into a store the array
 * holds marks that store and not the array, as it would at a key of an
 * object.
 *
 * What is inside an element store follows the source either way. An element
 * that is a store, where the definition has a plain object or an array of
 * its kind at the same index, is reshaped in place by its own marks, so that
 * a getter edited in source reaches it and the program's writes into it
 * stay. In an array the program has written to, the element at an index may
 * have come from another one, and is reshaped with the definition's at the
 * index it is at now.
 *
 * An array the program has not written takes the definition's elements and
 * length. Every element that is not reshaped in place takes the
 * definition's, and only the readers of an index whose element changed, and
 * of the length when it did, re-run.
 *
 * @param {Internals} internals
 * @param {unknown[]} definition
 */
function reshapeArray(internals, definition) {
  const { state, announce, ownKeys, touched } = internals;
  const array = /** @type {unknown[]} */ (/** @type {unknown} */ (state));
  const source = /** @type {unknown[]} */ (internalsOf(definition)?.state ?? definition);
  if (touched?.size) {
    // The program's elements stay where it put them. Only what is inside
    // them follows the source.
    const shared = Math.min(array.length, source.length);
    for (let index = 0; index < shared; index += 1) {
      const nested = internalsOf(array[index]);
      const value = source[index];
      if (nested && isOfKind(nested, storeKindOf(value))) {
        reshapeInto(nested, /** @type {object} */ (value));
      }
    }
    return;
  }
  const before = array.length;
  for (let index = 0; index < source.length; index += 1) {
    const key = String(index);
    const had = Object.hasOwn(array, index);
    if (!Object.hasOwn(source, index)) {
      // A hole in the definition is one in the store.
      if (had) {
        delete array[index];
        announce(key);
        announce(ownKeys);
      }
      continue;
    }
    const value = source[index];
    const old = array[index];
    const nested = internalsOf(old);
    const kind = storeKindOf(value);
    if (nested && isOfKind(nested, kind)) {
      reshapeInto(nested, /** @type {object} */ (value));
      continue;
    }
    const next = kind ? nestedStore(internals, /** @type {object} */ (value), false) : value;
    if (had && Object.is(old, next)) {
      continue;
    }
    array[index] = next;
    announce(key);
    if (!had) {
      announce(ownKeys);
    }
  }
  for (let index = source.length; index < array.length; index += 1) {
    announce(String(index));
  }
  array.length = source.length;
  if (array.length !== before) {
    announce("length");
    announce(ownKeys);
  }
}

export default store;
