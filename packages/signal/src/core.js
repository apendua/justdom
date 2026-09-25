/**
 * The tracking layer: who is reading, which channel they are being built
 * into, and the errors everything below agrees on.
 *
 * This package is a **pull** system. A `Signal` write does not recompute
 * anything; it marks what might now be wrong and stops. Values are produced
 * when somebody asks for them, and the asking is what establishes the order —
 * a `Derived` resolves its dependencies before returning, so a dependency is
 * always current before the thing that reads it, by construction rather than
 * by scheduling.
 *
 * That is the whole reason the graph carries no notion of depth. Ordering
 * used to be a number computed per node and honoured by the queue, which
 * meant the queue had to be able to see the shape of the graph — and it
 * could not, because a `Derived` wrapped in an ordinary `Observable` is
 * opaque. Under a pull model nothing needs to see the shape: the call stack
 * *is* the topological order, and it sees through anything, because it is
 * built out of the reads that actually happened.
 *
 * @import {Observer, Subscribable, Unsubscribable} from "./subscribable.js";
 */

/**
 * A node's value is current. Nothing upstream has moved since it last ran.
 */
export const CLEAN = 0;

/**
 * Something upstream of this node *may* have changed — a transitive
 * dependency was written, but whether it settled on a different value is not
 * known yet. Resolving a `CHECK` walks up and asks; if every dependency comes
 * back at the version this node last saw, the node goes back to `CLEAN`
 * without re-evaluating.
 *
 * This is what makes an `isEqual` cutoff worth anything. Without the middle
 * state, a write at the root of a deep chain would re-evaluate the whole
 * chain even when the first link swallowed the change.
 */
export const CHECK = 1;

/**
 * A direct dependency of this node definitely changed. The node has to run.
 */
export const DIRTY = 2;

/**
 * What a node needs from whoever is reading it.
 *
 * @typedef {object} ComputationLike
 * @property {(dependency: Dependency) => void} addDependency
 * @property {(fn: () => void) => void} onCleanup
 */

/**
 * Anything that can be depended upon: a node of this graph, or any
 * `Subscribable` at all.
 *
 * A foreign `Subscribable` is treated as a **source** — the same class of
 * thing as a `Signal`. It has no value to pull and nothing upstream of it
 * that this library can see, so there is nothing to order it against; it
 * emits, and what read it is marked stale. Which is exactly why an opaque
 * observable in the middle of a graph is no longer a problem: there is no
 * middle. Every dependency is either a node this library owns or a source it
 * does not, and neither needs a depth.
 *
 * @typedef {ReactiveNodeLike | Subscribable<unknown>} Dependency
 */

/**
 * The part of a node the tracking layer knows about. `ReactiveNode` is the
 * real thing; `core` only ever passes one around.
 *
 * @typedef {object} ReactiveNodeLike
 * @property {number} version
 * @property {(observer: Partial<Observer<void>>) => Unsubscribable} subscribe
 */

/**
 * The node currently evaluating. Reads that happen while this is set become
 * its dependencies.
 *
 * @type {ComputationLike | null}
 */
export let activeComputation = null;

/**
 * What `core` needs to know about a channel, which is nothing: it only ever
 * carries one around. `UpdateChannel` is the real thing.
 *
 * @typedef {object} UpdateChannelLike
 * @property {number} order
 * @property {string} name
 */

/**
 * The update channel effects are built into while this is set.
 *
 * A channel is a property of the output, and an output is usually built
 * rather than configured: a region of a graph is constructed by code that
 * knows which channel the region belongs to, node by node, through helpers
 * that do not take a channel and should not have to. Threading one through
 * every operator that happens to build an `Effect` would mean every such
 * helper growing a parameter for it, and would still miss whichever one was
 * forgotten. The forgotten ones are the dangerous ones: an effect left in the
 * default channel while the values it reads are deferred applies half of an
 * update as soon as it can and the other half a frame later.
 *
 * So this works the way `activeComputation` does, and for the same reason.
 *
 * An effect's run reinstates the effect's own channel, which is what makes
 * this survive a trip through the queue: construction happens inside the
 * caller's `withChannel` and reads it from there, but a re-run has no such
 * caller on the stack, and a nested `useEffect` built by both should not land
 * in two different channels depending on which run built it.
 *
 * @type {UpdateChannelLike | null}
 */
export let activeChannel = null;

/**
 * Build everything `fn` constructs into `channel`.
 *
 * Pass `null` for an effect that must stay in the default channel even though
 * it is built inside a region — anything shared between regions, which
 * belongs to none of them.
 *
 * @template T
 * @param {UpdateChannelLike | null} channel
 * @param {() => T} fn
 * @returns {T}
 */
export function withChannel(channel, fn) {
  const previous = activeChannel;
  activeChannel = channel;
  try {
    return fn();
  } finally {
    activeChannel = previous;
  }
}

/**
 * @template T
 * @param {ComputationLike | null} newComputation
 * @param {() => T} fn
 * @returns {T}
 */
export function withComputation(newComputation, fn) {
  const oldComputation = activeComputation;
  activeComputation = newComputation;
  try {
    return fn();
  } finally {
    activeComputation = oldComputation;
  }
}

/**
 * Where a warm sets aside the teardowns of the values it replaces, or `null`
 * outside one.
 *
 * A warm resolves what an atomic channel's effects read without running
 * them, and the effects go on holding the values they were last given until
 * the sweep — which can be frames later. A `Derived` that tore its old value
 * down the moment it was resolved would leave every one of those effects
 * holding a dead resource for as long as that takes: a geometry disposed
 * while a mesh still draws it, which three uploads again on the next frame
 * and which nothing will ever free. So while a warm is resolving, the old
 * value's teardowns go here instead, and the queue runs them once the lane
 * they were warmed for has nothing left to run — every effect in it has
 * either been handed the new value or been disposed.
 *
 * @type {Array<Array<() => void>> | null}
 */
let heldCleanups = null;

/**
 * Resolve `fn` as a warm for a lane that sets aside into `held`. For
 * `UpdateQueue`, and nothing else.
 *
 * @template T
 * @param {Array<Array<() => void>>} held
 * @param {() => T} fn
 * @returns {T}
 */
export function withHeldCleanups(held, fn) {
  const previous = heldCleanups;
  heldCleanups = held;
  try {
    return fn();
  } finally {
    heldCleanups = previous;
  }
}

/**
 * Set a replaced value's teardowns aside for the sweep, if a warm is under
 * way. Says whether it did; if not, they are the caller's to run.
 *
 * @param {Array<() => void>} cleanups
 * @returns {boolean}
 */
export function holdCleanups(cleanups) {
  if (heldCleanups === null) {
    return false;
  }
  if (cleanups.length > 0) {
    heldCleanups.push(cleanups);
  }
  return true;
}

/**
 * Record `dependency` as something the currently evaluating node read.
 *
 * @param {Dependency} dependency
 * @returns {void}
 */
export function addDependency(dependency) {
  if (activeComputation) {
    activeComputation.addDependency(dependency);
  }
}

/**
 * @param {() => void} fn
 * @returns {void}
 */
export function onCleanup(fn) {
  if (activeComputation) {
    activeComputation.onCleanup(fn);
  } else {
    console.warn(
      new Error(
        "onCleanup called outside of a computation. " +
          "It's almost certainly not what you want. " +
          "Please examine the stack trace and make sure everything is working as expected.",
      ),
    );
    // To prevent memory leaks, clean up immediately if we're not inside a
    // computation.
    fn();
  }
}

/**
 * @deprecated Use onCleanup instead.
 * @param {() => void} fn
 * @returns {void}
 */
export function onInvalidate(fn) {
  return onCleanup(fn);
}

/**
 * @template TResult
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => TResult} fn
 * @returns {(...args: TArgs) => TResult}
 */
export function makeNonReactive(fn) {
  return function (...args) {
    return withComputation(null, () => fn(...args));
  };
}

export class CircularDependencyError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message) {
    super(message || "Circular dependency detected");
    this.name = "CircularDependencyError";
  }
}

/**
 * Not an error so much as "not yet".
 *
 * A node may be asked for a value before it has one — a `Signal` with no
 * initial value, a `Derived` whose source has not emitted. Everything in this
 * package treats it as a request to be left alone rather than as a failure:
 * an effect that catches one skips its run and waits to be told again.
 */
export class NoValueError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message) {
    super(message || "No value available");
    this.name = "NoValueError";
  }
}

/**
 * @typedef {() => (void | (() => void))} ResourceStart
 */

/**
 * Work with a teardown, and nothing else.
 *
 * Several things a node wants to hang off its own liveness are not streams of
 * anything: they run when it wakes up and undo themselves when it lets go. A
 * memo putting itself in a cache and taking itself out again is one;
 * `Derived.from` holding a subscription is another.
 *
 * Each of those could be an RxJS `Observable` whose subscribe function
 * returns a teardown and never emits — a fair way to spell it, and one that
 * costs an Observable, a Subscriber and a Subscription to establish that the
 * thing which emits nothing did not emit anything. This is that, spelled as
 * what it is.
 *
 * The one piece of RxJS behaviour worth keeping is what happens when the work
 * throws on the way in: the subscriber is told, rather than the exception
 * coming back out of `subscribe`.
 */
export class Resource {
  /** @type {ResourceStart} */
  #start;

  /**
   * @param {ResourceStart} start
   */
  constructor(start) {
    this.#start = start;
  }

  /**
   * @param {Partial<Observer<never>>} [observer]
   * @returns {Unsubscribable}
   */
  subscribe(observer) {
    /** @type {void | (() => void)} */
    let teardown;
    try {
      teardown = this.#start();
    } catch (err) {
      observer?.error?.(err);
      return { unsubscribe: () => {} };
    }
    let closed = false;
    return {
      unsubscribe: () => {
        if (closed) {
          return;
        }
        closed = true;
        teardown?.();
      },
    };
  }
}

/**
 * @param {ResourceStart} start
 * @returns {Resource}
 */
export function resource(start) {
  return new Resource(start);
}

/**
 * Everything `source` emits after this call returns.
 *
 * A dependency's job is to say *when* something changed, and a value handed
 * over during `subscribe` did not change — it is the value the reader is
 * about to compute with anyway. Passing it on would mark the reader stale the
 * instant it read anything.
 *
 * @template T
 * @param {Subscribable<T>} source
 * @returns {Subscribable<T>}
 */
export function skipSynchronousValues(source) {
  return {
    subscribe: (observer) => {
      let initialized = false;
      let closed = false;
      const subscription = source.subscribe({
        next: (value) => {
          if (initialized && !closed) {
            observer.next?.(value);
          }
        },
        error: (err) => {
          if (!closed) {
            closed = true;
            observer.error?.(err);
          }
        },
        complete: () => {
          if (!closed) {
            closed = true;
            observer.complete?.();
          }
        },
      });
      initialized = true;
      return {
        unsubscribe: () => {
          closed = true;
          subscription.unsubscribe();
        },
      };
    },
  };
}

/**
 * Read a value out of a replaying observable and depend on it.
 *
 * Works with anything that emits synchronously on subscription — a
 * `ReplaySubject`, a `BehaviorSubject`, anything piped through
 * `shareReplay(1)`. The synchronously emitted value is returned; the
 * observable itself becomes a dependency, so later emissions mark the reader
 * stale.
 *
 * @template T
 * @param {Subscribable<T>} dependency
 * @param {() => T} [getDefaultValue]
 * @returns {T}
 */
export function valueOf(dependency, getDefaultValue) {
  /** @type {{ value: T } | undefined} */
  let observed;
  let initialized = false;
  /** @type {Subscribable<T>} */
  const proxy = {
    subscribe: (observer) => {
      const subscription = dependency.subscribe({
        next: (value) => {
          if (!initialized) {
            observed = { value };
          }
          observer.next?.(value);
        },
        error: (err) => {
          observer.error?.(err);
        },
        complete: () => {
          observer.complete?.();
        },
      });
      return {
        unsubscribe: () => {
          subscription.unsubscribe();
        },
      };
    },
  };
  // Adding the proxy as a dependency subscribes it, which is what captures
  // the replayed value.
  addDependency(proxy);
  initialized = true;
  if (!observed) {
    if (getDefaultValue) {
      return getDefaultValue();
    }
    throw new NoValueError();
  }
  return observed.value;
}
