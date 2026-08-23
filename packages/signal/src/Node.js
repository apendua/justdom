import {
  CLEAN,
  CHECK,
  DIRTY,
  Resource,
  makeNonReactive,
  skipSynchronousValues,
  withComputation,
} from "./core.js";

/**
 * @import {Observer, Unsubscribable} from "rxjs";
 * @import {Dependency} from "./core.js";
 */

/** @type {Unsubscribable} */
const CLOSED = { unsubscribe: () => {} };

/**
 * Handed back by `detachCleanups` when there was nothing to detach, so that
 * the commonest recomputation — a node with no teardowns at all — allocates
 * nothing. Frozen because the whole point is that it is shared: anything that
 * tried to push onto it would be pushing onto every caller's list at once,
 * and would throw here instead.
 *
 * @type {Array<() => void>}
 */
const NO_CLEANUPS = /** @type {Array<() => void>} */ (/** @type {unknown} */ (Object.freeze([])));

/**
 * One dependency edge, and everything this node remembers about it.
 *
 * `version` is the crux. It is the version of the dependency as of this
 * node's last evaluation, and comparing it against the dependency's version
 * now is how a `CHECK` is resolved without running anything: the dependency
 * is asked to bring itself up to date, and if it arrives at the same version
 * it had before, it did not really change and this node does not have to run.
 */
class Edge {
  /** @type {number} */
  version = -1;

  /**
   * How many times a foreign source has emitted. A `Subscribable` that is not
   * a node of this graph has no version of its own, so the edge counts for
   * it; the comparison above then works uniformly for both kinds.
   *
   * @type {number}
   */
  emitted = 0;

  /** @type {Unsubscribable | null} */
  subscription = null;

  /** Whether this edge is currently held open. */
  attached = false;

  /** Whether the last evaluation read this dependency. */
  seen = false;

  /**
   * Whether this edge survives a dependency sweep. A resource is attached
   * out of band rather than by being read, so nothing re-reads it and the
   * sweep would drop it on the first recomputation.
   */
  pinned = false;
}

/**
 * One entry in a node's external observer list.
 *
 * `closed` is why this is an object rather than the observer itself. An
 * observer notified during a round may unsubscribe another, and the one that
 * is gone must not be called even though the round is iterating a snapshot
 * taken before it left.
 *
 * @typedef {object} Entry
 * @property {Partial<Observer<void>>} observer
 * @property {boolean} closed
 */

/**
 * @typedef {object} ReactiveNodeOptions
 * @property {() => number} [resetDelay] How long to stay awake after the last
 *   reader leaves, in ms. Negative — the default — lets go there and then. A
 *   function rather than a number because the answer is a subclass's field,
 *   and a subclass assigns its fields after `super()`.
 */

/**
 * A node of the dependency graph.
 *
 * Three things descend from this and they divide the work cleanly: a `Signal`
 * is an input and has a value but no dependencies, a `Derived` is a
 * transformation and has both, an `Effect` is an output and has dependencies
 * but no value. What they share is here — the edges, the liveness, and the
 * two-colour staleness marking that lets a write announce itself in one cheap
 * downward walk without computing anything.
 *
 * ### Marking, and why there are two colours
 *
 * A write marks its direct dependents `DIRTY` and everything below them
 * `CHECK`, and stops. The walk is cut short at any node that is already
 * marked, because everything beneath it was marked when *it* was — so a burst
 * of writes into one subgraph costs one walk, not one per write.
 *
 * `CHECK` means "ask, don't assume". Resolving one compares each dependency's
 * version against the version this node last saw, which is how an `isEqual`
 * that swallows a change stops the change from travelling any further. With
 * only one colour, every write at the root of a chain would re-evaluate the
 * whole chain to discover that nothing downstream actually moved.
 *
 * ### Liveness
 *
 * A node is **live** while something is reading it: another node depends on
 * it, or an external observer subscribed. Only a live node holds
 * subscriptions to foreign sources, keeps a cached value, or registers itself
 * as a dependent of the things it reads — so demand flows up from effects,
 * and a graph nobody is looking at holds nothing open.
 */
export default class ReactiveNode {
  /** @type {number} */
  state = CLEAN;

  /**
   * Bumped whenever this node's value actually changes. Dependents compare
   * against it to resolve a `CHECK`; nothing else reads it.
   *
   * @type {number}
   */
  version = 0;

  /** @type {Map<Dependency, Edge>} */
  #edges = new Map();

  /** @type {Set<ReactiveNode>} */
  #dependents = new Set();

  /** @type {ReactiveNode[] | null} */
  #dependentsSnapshot = null;

  /** @type {Set<Entry>} */
  #observers = new Set();

  /** @type {Entry[] | null} */
  #observersSnapshot = null;

  /** Whether this node currently holds its dependencies open. */
  #connected = false;

  /** @type {Array<() => void>} */
  #cleanups = [];

  /**
   * The error this node died of, if it did. Terminal, because the only thing
   * that can produce one is a foreign source erroring, and an observable that
   * has errored will not emit again. Everything downstream has been told, and
   * anyone arriving later is told immediately rather than waiting for news
   * that cannot come.
   *
   * @type {{ value: unknown } | null}
   */
  #failure = null;

  /** @type {ReturnType<typeof setTimeout> | null} */
  #resetTimer = null;

  /** @type {ReactiveNodeOptions} */
  #options;

  /**
   * @param {ReactiveNodeOptions} [options]
   */
  constructor(options) {
    this.#options = options ?? {};
  }

  /**
   * Whether anything is reading this node.
   *
   * @returns {boolean}
   */
  isLive() {
    return this.#dependents.size > 0 || this.#observers.size > 0;
  }

  /**
   * Whether this node is holding its dependencies open.
   *
   * @returns {boolean}
   */
  isConnected() {
    return this.#connected;
  }

  /**
   * @returns {Iterable<Dependency>}
   */
  dependencies() {
    return this.#edges.keys();
  }

  /**
   * Record that the currently evaluating node read `dependency`.
   *
   * @param {Dependency} dependency
   * @returns {void}
   */
  addDependency(dependency) {
    let edge = this.#edges.get(dependency);
    if (!edge) {
      edge = new Edge();
      this.#edges.set(dependency, edge);
      if (this.#connected) {
        this.#attach(dependency, edge);
      }
    }
    edge.seen = true;
  }

  /**
   * Attach something whose lifetime should follow this node's, rather than
   * its evaluation. Survives dependency sweeps; removed only by
   * `removeResource` or by this node going dormant.
   *
   * @param {Dependency} dependency
   * @returns {void}
   */
  addResource(dependency) {
    this.addDependency(dependency);
    const edge = this.#edges.get(dependency);
    if (edge) {
      edge.pinned = true;
    }
  }

  /**
   * @param {Dependency} dependency
   * @returns {void}
   */
  removeResource(dependency) {
    const edge = this.#edges.get(dependency);
    if (!edge || !edge.pinned) {
      return;
    }
    this.#edges.delete(dependency);
    this.#detach(dependency, edge);
  }

  /**
   * @param {() => void} fn
   * @returns {void}
   */
  onCleanup(fn) {
    this.#cleanups.push(makeNonReactive(fn));
  }

  /**
   * @returns {void}
   */
  cleanup() {
    const cleanups = this.#cleanups;
    if (cleanups.length === 0) {
      return;
    }
    this.#cleanups = [];
    for (let index = 0; index < cleanups.length; index += 1) {
      cleanups[index]();
    }
  }

  /**
   * Take the teardowns registered so far off this node, without running them.
   *
   * For a caller that cannot yet say whether they are owed. A `Derived`
   * comparing a fresh value against the one it holds is the case: which set
   * of teardowns survives depends on which *value* survives, and that is not
   * known until the new one has been built.
   *
   * @returns {Array<() => void>}
   */
  detachCleanups() {
    const cleanups = this.#cleanups;
    if (cleanups.length === 0) {
      // Nothing to detach, and nothing to allocate. Deliberately *not* the
      // live array: handing that back and leaving it in place would alias the
      // two, and everything the next run registered would arrive in the list
      // the caller is holding as "what the previous run left behind".
      return NO_CLEANUPS;
    }
    this.#cleanups = [];
    return cleanups;
  }

  /**
   * Put a detached list back, ahead of anything registered since.
   *
   * @param {Array<() => void>} cleanups
   * @returns {void}
   */
  restoreCleanups(cleanups) {
    if (cleanups.length === 0) {
      return;
    }
    this.#cleanups = this.#cleanups.length === 0 ? cleanups : cleanups.concat(this.#cleanups);
  }

  /**
   * Run `fn` as this node's evaluation: reads inside it become this node's
   * dependencies, and anything it stopped reading is let go of on the way
   * out.
   *
   * @template T
   * @param {() => T} fn
   * @param {boolean} [keepCleanups] leave the previous run's teardowns
   *   registered rather than running them on the way in — for a caller that
   *   will decide afterwards, through `detachCleanups`, which set is owed.
   * @returns {T}
   */
  track(fn, keepCleanups = false) {
    if (!keepCleanups) {
      this.cleanup();
    }
    const edges = this.#edges;
    for (const edge of edges.values()) {
      edge.seen = edge.pinned;
    }
    try {
      return withComputation(this, fn);
    } finally {
      // One pass, doing both halves of the bookkeeping: drop what went
      // unread, and record where everything else stood. The versions are
      // taken here rather than at the moment of each read because a
      // dependency is only settled once it has been resolved, and resolving
      // it is what the read was doing.
      for (const [dependency, edge] of edges) {
        if (!edge.seen) {
          edges.delete(dependency);
          this.#detach(dependency, edge);
          continue;
        }
        edge.version = versionOf(dependency, edge);
      }
    }
  }

  /**
   * @template {unknown[]} TArgs
   * @template TReturn
   * @param {(...args: TArgs) => TReturn} fn
   * @returns {(...args: TArgs) => TReturn}
   */
  bind(fn) {
    return (...args) => this.track(() => fn(...args));
  }

  /**
   * Whether any dependency has moved since this node last ran.
   *
   * Resolving each dependency first is what makes the answer trustworthy, and
   * what makes this the whole ordering mechanism: by the time the question is
   * answered, everything upstream is current.
   *
   * @returns {boolean}
   */
  hasStaleDependencies() {
    for (const [dependency, edge] of this.#edges) {
      if (dependency instanceof ReactiveNode) {
        dependency.updateIfNecessary();
      }
      if (edge.version !== versionOf(dependency, edge)) {
        return true;
      }
      // Resolving one dependency can invalidate this node outright — a
      // `Derived` that reads a foreign source subscribes to it on the way up,
      // and the source may fire. Nothing more to ask once that has happened.
      if (this.state === DIRTY) {
        return true;
      }
    }
    return false;
  }

  /**
   * Bring this node's value up to date. A `Signal` has nothing to do; the
   * subclasses that compute override this.
   *
   * @returns {void}
   */
  updateIfNecessary() {}

  /**
   * Mark this node stale and, the first time it stops being clean, tell
   * everything below it.
   *
   * @param {number} state `CHECK` or `DIRTY`
   * @returns {void}
   */
  markStale(state) {
    if (this.state >= state) {
      // Already at least this suspect. Whatever is below was told when this
      // node was first marked, and is still waiting to be resolved.
      return;
    }
    const wasClean = this.state === CLEAN;
    this.state = state;
    if (wasClean) {
      this.invalidateDependents(CHECK);
    }
  }

  /**
   * Tell everything downstream that this node may have moved.
   *
   * Dependents first, in registration order, then external observers.
   * Both walks iterate a snapshot with a liveness check, because a notified
   * party may unsubscribe another mid-round.
   *
   * @param {number} state
   * @returns {void}
   */
  invalidateDependents(state) {
    if (this.#dependents.size > 0) {
      const dependents = this.#peekDependents();
      for (let index = 0; index < dependents.length; index += 1) {
        const dependent = dependents[index];
        if (this.#dependents.has(dependent)) {
          dependent.markStale(state);
        }
      }
    }
    if (this.#observers.size > 0) {
      const observers = this.#peekObservers();
      for (let index = 0; index < observers.length; index += 1) {
        const entry = observers[index];
        if (!entry.closed) {
          entry.observer.next?.(undefined);
        }
      }
    }
  }

  /**
   * Subscribe to this node's **invalidations**, not to its values.
   *
   * An observer hears that the node may have changed, eagerly, as part of the
   * write that changed it — and then decides for itself whether to pull. That
   * is the whole of the push half of this library: news travels, values do
   * not. Anything that wants the value on a schedule is an `Effect`.
   *
   * @param {Partial<Observer<void>>} observer
   * @returns {Unsubscribable}
   */
  subscribe(observer) {
    if (this.#failure) {
      observer.error?.(this.#failure.value);
      return CLOSED;
    }
    /** @type {Entry} */
    const entry = { observer, closed: false };
    this.#observers.add(entry);
    this.#observersSnapshot = null;
    this.#cancelReset();
    if (!this.#connected) {
      this.connect();
    }
    return {
      unsubscribe: () => {
        if (entry.closed) {
          return;
        }
        entry.closed = true;
        this.#observers.delete(entry);
        this.#observersSnapshot = null;
        if (!this.isLive()) {
          this.#scheduleReset();
        }
      },
    };
  }

  /**
   * Register a node that reads this one. The internal counterpart of
   * `subscribe`: no observer object, no subscription, one method call each
   * way.
   *
   * @param {ReactiveNode} dependent
   * @returns {void}
   */
  addDependent(dependent) {
    if (this.#failure) {
      dependent.fail(this.#failure.value);
      return;
    }
    this.#dependents.add(dependent);
    this.#dependentsSnapshot = null;
    this.#cancelReset();
    if (!this.#connected) {
      this.connect();
    }
  }

  /**
   * @param {ReactiveNode} dependent
   * @returns {void}
   */
  removeDependent(dependent) {
    if (!this.#dependents.delete(dependent)) {
      return;
    }
    this.#dependentsSnapshot = null;
    if (!this.isLive()) {
      this.#scheduleReset();
    }
  }

  /**
   * Hold this node's dependencies open. Called when the first reader arrives.
   *
   * @returns {void}
   */
  connect() {
    this.#connected = true;
    // The map is walked as it stands: attaching can start a resource, which
    // can evaluate and replace the edges wholesale. What that leaves behind
    // is settled by `track`'s own bookkeeping, and anything it added attaches
    // on the spot through `addDependency`, this node being connected by now.
    for (const [dependency, edge] of this.#edges) {
      this.#attach(dependency, edge);
    }
    this.onConnect();
  }

  /**
   * @returns {void}
   */
  disconnect() {
    this.#cancelReset();
    if (!this.#connected) {
      return;
    }
    this.#connected = false;
    for (const [dependency, edge] of this.#edges) {
      this.#detach(dependency, edge);
    }
    this.cleanup();
    this.onDisconnect();
  }

  /**
   * Hooks for subclasses. `onConnect` runs once this node is holding its
   * dependencies; `onDisconnect` once it has let go of them.
   *
   * @returns {void}
   */
  onConnect() {}

  /**
   * @returns {void}
   */
  onDisconnect() {}

  /**
   * Tell everyone, then die. Nothing is left subscribed and nothing more will
   * be said; a reader arriving afterwards is handed the same error.
   *
   * @param {unknown} err
   * @returns {void}
   */
  fail(err) {
    if (this.#failure) {
      return;
    }
    this.#failure = { value: err };
    const dependents = this.#peekDependents();
    const observers = this.#peekObservers();
    this.#dependents.clear();
    this.#dependentsSnapshot = null;
    this.#observers.clear();
    this.#observersSnapshot = null;
    this.disconnect();
    for (let index = 0; index < dependents.length; index += 1) {
      dependents[index].fail(err);
    }
    for (let index = 0; index < observers.length; index += 1) {
      const entry = observers[index];
      if (!entry.closed) {
        entry.closed = true;
        entry.observer.error?.(err);
      }
    }
  }

  /**
   * @returns {unknown}
   */
  get failure() {
    return this.#failure;
  }

  /**
   * @param {Dependency} dependency
   * @param {Edge} edge
   * @returns {void}
   */
  #attach(dependency, edge) {
    if (edge.attached) {
      return;
    }
    edge.attached = true;
    if (dependency instanceof ReactiveNode) {
      // The overwhelmingly common case: node reading node, wired up directly
      // with nothing in between.
      dependency.addDependent(this);
      return;
    }
    // Non-reactive, because a foreign source's `subscribe` may itself read
    // reactive things, and those are not this node's dependencies.
    withComputation(null, () => {
      if (dependency instanceof Resource) {
        // A resource never emits; an error on the way in is the one thing it
        // can deliver.
        edge.subscription = dependency.subscribe({
          error: (err) => this.fail(err),
        });
        return;
      }
      edge.subscription = skipSynchronousValues(dependency).subscribe({
        next: () => {
          edge.emitted += 1;
          this.markStale(DIRTY);
        },
        error: (err) => this.fail(err),
      });
    });
  }

  /**
   * @param {Dependency} dependency
   * @param {Edge} edge
   * @returns {void}
   */
  #detach(dependency, edge) {
    if (!edge.attached) {
      return;
    }
    edge.attached = false;
    if (dependency instanceof ReactiveNode) {
      dependency.removeDependent(this);
      return;
    }
    const subscription = edge.subscription;
    edge.subscription = null;
    subscription?.unsubscribe();
  }

  /**
   * @returns {ReactiveNode[]}
   */
  #peekDependents() {
    if (!this.#dependentsSnapshot) {
      this.#dependentsSnapshot = Array.from(this.#dependents);
    }
    return this.#dependentsSnapshot;
  }

  /**
   * @returns {Entry[]}
   */
  #peekObservers() {
    if (!this.#observersSnapshot) {
      this.#observersSnapshot = Array.from(this.#observers);
    }
    return this.#observersSnapshot;
  }

  #cancelReset() {
    if (this.#resetTimer !== null) {
      clearTimeout(this.#resetTimer);
      this.#resetTimer = null;
    }
  }

  /**
   * @returns {void}
   */
  #scheduleReset() {
    const delay = this.#options.resetDelay?.() ?? -1;
    if (!(delay >= 0)) {
      this.disconnect();
      return;
    }
    this.#resetTimer = setTimeout(() => {
      this.#resetTimer = null;
      if (!this.isLive()) {
        this.disconnect();
      }
    }, delay);
  }
}

/**
 * Run a detached list of teardowns, in the order they were registered.
 *
 * @param {Array<() => void>} cleanups
 * @returns {void}
 */
export function runCleanups(cleanups) {
  for (let index = 0; index < cleanups.length; index += 1) {
    cleanups[index]();
  }
}

/**
 * Where a dependency stands right now: its own version if it is a node of
 * this graph, or how many times it has emitted if it is a foreign source.
 *
 * @param {Dependency} dependency
 * @param {Edge} edge
 * @returns {number}
 */
function versionOf(dependency, edge) {
  return dependency instanceof ReactiveNode ? dependency.version : edge.emitted;
}
