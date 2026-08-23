import ReactiveNode from "./Node.js";
import {
  CLEAN,
  CHECK,
  DIRTY,
  CircularDependencyError,
  NoValueError,
  activeChannel,
} from "./core.js";
import { updateQueue, defaultChannel } from "./scheduler.js";

/**
 * @import UpdateChannel from "./UpdateChannel.js";
 */

/**
 * The work an effect does.
 *
 * Typed as returning `unknown` rather than `void | (() => void)` so that the
 * commonest one-liner — an arrow body that happens to evaluate to something,
 * `() => list.push(value.get())` — is not a type error. If what comes back is
 * a function it is kept as the teardown; anything else is ignored.
 *
 * @typedef {() => unknown} EffectRun
 */

/**
 * How many runs in a row an effect may invalidate itself on before the loop
 * is called a loop. Generous, because a converging one settles on the second
 * run and anything that has not settled in a hundred never will.
 */
const MAX_SELF_INVALIDATIONS = 100;

/**
 * @typedef {object} EffectOptions
 * @property {UpdateChannel} [channel] which channel to schedule this effect's
 *   re-runs in. Fixed for the life of the effect.
 * @property {(err: unknown) => void} [onError] what to do when the effect
 *   throws. Without one, the exception comes back out of whatever was
 *   draining the queue.
 * @property {boolean} [deferred] schedule the first run instead of performing
 *   it during construction.
 * @property {string} [name] shown in diagnostics
 */

/**
 * An output: work that reads reactive values and does something with them.
 *
 * This is the only kind of node that is *scheduled*. A `Signal` and a
 * `Derived` need no schedule — one holds a value and the other computes one
 * on demand — but an effect touches the world, and when it touches it is
 * exactly the question a channel answers.
 *
 * So an invalidated effect is not flagged and forgotten; it goes on its
 * channel's queue, and the channel decides when the queue drains and how long
 * it may spend doing so. When the effect finally runs, it pulls the values it
 * needs, which resolves everything upstream of it at that moment — so a
 * deferred effect reads the state of the world as of when it ran, never a
 * half-settled version of it.
 *
 * An effect runs once during construction, so that whatever it is
 * synchronising starts out synchronised. Pass `deferred` to have even the
 * first run wait for the channel.
 */
export class Effect extends ReactiveNode {
  /** @type {EffectRun} */
  #run;

  /** @type {UpdateChannel} */
  #channel;

  /** @type {((err: unknown) => void) | undefined} */
  #onError;

  /** @type {string} */
  #name;

  /** @type {boolean} */
  #disposed = false;

  /** @type {boolean} */
  #running = false;

  /** @type {number} */
  #runs = 0;

  /** Whether the run in progress invalidated something it reads itself. */
  #selfInvalidated = false;

  /** @type {number} */
  #consecutiveSelfInvalidations = 0;

  /**
   * The queue's dedup flag. Public because the queue owns it: an effect
   * invalidated ten times before it gets a chance to run is queued once.
   *
   * @type {boolean}
   */
  queued = false;

  /**
   * The queue's per-pass run count, kept here so that it costs a field rather
   * than a map keyed by every effect in the program. See `UpdateQueue`.
   *
   * @type {number}
   */
  passId = -1;

  /** @type {number} */
  runsInPass = 0;

  /**
   * @param {EffectRun} run
   * @param {EffectOptions} [options]
   */
  constructor(run, options = {}) {
    super();
    this.#run = run;
    this.#onError = options.onError;
    this.#name = options.name ?? "effect";
    // An explicit channel wins; failing that, whichever region this is being
    // built inside; failing that, the default. Which is what lets a region be
    // built by helpers that know nothing about channels.
    this.#channel =
      options.channel ?? /** @type {UpdateChannel | null} */ (activeChannel) ?? defaultChannel;
    this.state = DIRTY;
    // An effect is a root of demand rather than something demanded: it holds
    // its dependencies open from birth, and that is what keeps everything it
    // reads awake.
    this.connect();
    if (options.deferred) {
      updateQueue.enqueue(this);
      return;
    }
    try {
      this.#execute();
    } catch (err) {
      // An effect that could not get through its first run has no business
      // staying subscribed to what it managed to read on the way.
      this.dispose();
      throw err;
    }
    this.state = CLEAN;
  }

  get name() {
    return this.#name;
  }

  get channel() {
    return this.#channel;
  }

  get isDisposed() {
    return this.#disposed;
  }

  /**
   * How many times this effect has run.
   *
   * @returns {number}
   */
  getRuns() {
    return this.#runs;
  }

  /**
   * An effect is live until it is disposed. Nothing reads it — it is what
   * does the reading — so the base class's answer, which counts readers, is
   * not the right one here.
   *
   * @returns {boolean}
   */
  isLive() {
    return !this.#disposed;
  }

  /**
   * @param {number} state
   * @returns {void}
   */
  markStale(state) {
    if (this.#disposed) {
      return;
    }
    if (this.#running) {
      // The effect wrote something it reads itself. Not an error on its own:
      // an effect that clamps or normalises what it reads settles on the
      // second pass, and that is a useful thing to be able to write. It is
      // only an error if it never settles, which `#execute` decides by
      // counting.
      this.#selfInvalidated = true;
    }
    if (this.state < state) {
      this.state = state;
    }
    // Unlike a `Derived`, an effect does not wait to be asked. Nothing is
    // going to ask.
    updateQueue.enqueue(this);
  }

  /**
   * @internal Called by `UpdateQueue` when this effect's turn comes.
   * @returns {void}
   */
  runFromQueue() {
    if (this.#disposed || this.state === CLEAN) {
      return;
    }
    if (this.state === CHECK && !this.hasStaleDependencies()) {
      // Something upstream was written but settled on the value this effect
      // already saw. Worth finding out before spending any of the channel's
      // budget on the work itself.
      this.state = CLEAN;
      return;
    }
    this.state = CLEAN;
    this.#execute();
  }

  /**
   * Run now, whatever the channel would have said. For a caller that needs
   * this effect's output before the channel's next pass.
   *
   * @returns {void}
   */
  flush() {
    if (this.#disposed || this.state === CLEAN) {
      return;
    }
    updateQueue.dequeue(this);
    this.runFromQueue();
  }

  /**
   * Stop. Cleanups run, subscriptions are dropped, and anything still queued
   * for this effect is discarded.
   *
   * @returns {void}
   */
  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    updateQueue.dequeue(this);
    this.disconnect();
  }

  /**
   * @returns {void}
   */
  #execute() {
    this.#running = true;
    this.#selfInvalidated = false;
    this.#runs += 1;
    /** @type {unknown} */
    let teardown;
    try {
      teardown = this.track(this.#run);
    } catch (err) {
      this.#running = false;
      if (err instanceof NoValueError) {
        // Not an error so much as "not yet". The effect stays subscribed to
        // whatever it did manage to read, and will be told when that moves.
        return;
      }
      if (this.#onError) {
        this.#onError(err);
        this.#settleOrGiveUp();
        return;
      }
      throw err;
    }
    this.#running = false;
    if (typeof teardown === "function") {
      // Registered after the run, because `track` clears the previous run's
      // cleanups on the way in.
      this.onCleanup(/** @type {() => void} */ (teardown));
    }
    this.#settleOrGiveUp();
  }

  /**
   * An effect that invalidates itself gets to try again — but not forever.
   * A run that does not invalidate itself has settled, and the count starts
   * over; a run that does, on top of a long enough streak of them, is a loop
   * that is not going to converge.
   *
   * @returns {void}
   */
  #settleOrGiveUp() {
    if (!this.#selfInvalidated) {
      this.#consecutiveSelfInvalidations = 0;
      return;
    }
    this.#consecutiveSelfInvalidations += 1;
    if (this.#consecutiveSelfInvalidations > MAX_SELF_INVALIDATIONS) {
      this.#consecutiveSelfInvalidations = 0;
      throw new CircularDependencyError(
        `Effect "${this.#name}" invalidated one of its own dependencies on ` +
          `${MAX_SELF_INVALIDATIONS} consecutive runs without settling`,
      );
    }
  }
}

/**
 * @param {EffectRun} run
 * @param {EffectOptions} [options]
 * @returns {Effect}
 */
export function effect(run, options) {
  return new Effect(run, options);
}

export default Effect;
