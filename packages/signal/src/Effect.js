import ReactiveNode from "./Node.js";
import {
  CLEAN,
  CHECK,
  DIRTY,
  CircularDependencyError,
  NoValueError,
  activeChannel,
  onCleanup,
} from "./core.js";
import { updateQueue, defaultChannel } from "./scheduler.js";

/**
 * @import UpdateChannel from "./UpdateChannel.js";
 */

/**
 * What a run is handed: the effect's own failure channel, and nothing else.
 *
 * An effect reports a *synchronous* failure by throwing — the run is on the
 * stack, so an exception finds its way out. Work the run merely *starts* has
 * no such stack to fail into: a subscription that errors later, a listener
 * whose source dies, a request that comes back a rejection. `fail` is where
 * those go, and it lands them exactly where a thrown one lands.
 *
 * It is passed in rather than reached for because the alternative is reaching
 * for the effect itself, and the run is the one place the effect is not yet
 * available: `const effect = useEffect(() => ... effect.fail(err) ...)` closes
 * over a binding its own initialiser is still evaluating. That works only for
 * as long as nothing calls it during the run, which is a fact about the code
 * inside rather than a guarantee this side can make.
 *
 * @typedef {object} EffectContext
 * @property {(err: unknown) => void} fail Report a failure that happened after
 *   this run returned. Handled exactly as a thrown one: `onError` if the
 *   effect has one, and otherwise the effect fails — its cleanups run, whatever
 *   is watching it is told, and it stops.
 */

/**
 * The work an effect does.
 *
 * Typed as returning `unknown` rather than `void | (() => void)` so that the
 * commonest one-liner — an arrow body that happens to evaluate to something,
 * `() => list.push(value.get())` — is not a type error. If what comes back is
 * a function it is kept as the teardown; anything else is ignored.
 *
 * @typedef {(context: EffectContext) => unknown} EffectRun
 */

/**
 * How many runs in a row an effect may end still owing itself another before
 * the loop is called a loop. Generous, because a converging one settles on
 * the second run and anything that has not settled in a hundred never will.
 */
const MAX_SELF_INVALIDATIONS = 100;

/**
 * @typedef {object} EffectOptions
 * @property {UpdateChannel} [channel] which channel to schedule this effect's
 *   re-runs in. Fixed for the life of the effect.
 * @property {(err: unknown) => void} [onError] what to do when the effect
 *   throws, or when its run reports a failure through `context.fail`. Without
 *   one, a thrown exception comes back out of whatever was draining the queue
 *   and a reported one fails the effect outright.
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

  /**
   * Whether something this effect reads was invalidated while it was running.
   *
   * Usually its own write — the clamp-or-normalise pattern — but it can also
   * come back around through another effect that the write set going. Both
   * are the same question from here: did this run leave itself with work to
   * redo, and does that keep happening.
   */
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
   * Handed to every run, and the same object each time — there is nothing in
   * it that varies by run, and a run that holds on to it past its own turn is
   * holding the right thing anyway.
   *
   * @type {EffectContext}
   */
  #context = { fail: (err) => this.#reportFailure(err) };

  /**
   * `track` calls what it is given with no arguments, so this is what it is
   * given: one wrapper, built once, that hands the run its context.
   *
   * @type {() => unknown}
   */
  #invoke = () => this.#run(this.#context);

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
    // Settled *before* the run, exactly as `runFromQueue` does it. A first
    // run that writes something it reads marks this effect mid-run; writing
    // `CLEAN` afterwards would erase that mark, and the queued re-run would
    // then find nothing to do and skip — leaving the effect out of step with
    // the value it just moved.
    this.state = CLEAN;
    try {
      this.#execute();
    } catch (err) {
      // An effect that could not get through its first run has no business
      // staying subscribed to what it managed to read on the way.
      this.dispose();
      throw err;
    }
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
      // Something this effect reads moved while it was running — its own
      // write, most of the time. Not an error on its own: an effect that
      // clamps or normalises what it reads settles on the second run, and
      // that is a useful thing to be able to write. It is only an error if it
      // never settles, which `#settleOrGiveUp` decides by counting.
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
    if (this.#running) {
      // A run of this effect is still on the stack. It got here because the
      // run wrote something it reads, which queued this effect, and the
      // write's own `batch` drained the queue on its way out — with the run
      // that caused it half finished underneath.
      //
      // Re-entering would be worse than useless: the outer `track` settles
      // the dependency bookkeeping in its `finally`, using `seen` flags the
      // inner run has already reset, and the outer run's teardown would
      // register after the inner one's, pairing every teardown with the
      // wrong run. So this declines, and `#execute` — which is still down
      // there and can see the mark — does the re-run itself once it unwinds.
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
   * Not charged to any pass: the queue's per-pass run cap — the backstop that
   * turns a cycle between two effects into a `CircularDependencyError` rather
   * than a hang — counts what a drain runs, and this is not a drain. Calling
   * it in a loop is therefore the caller's own loop to bound. What it cannot
   * do is re-enter a run that is already on the stack; that is refused, the
   * same way a queued run is.
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
    // A loop, because an effect that writes what it reads has to be re-run,
    // and the queue cannot do it: the queue would have to re-enter a run that
    // is still on the stack. So the re-run happens here, after each run has
    // fully unwound — teardowns paired with their own runs, dependency
    // bookkeeping settled once per run — and `#settleOrGiveUp` bounds it, as
    // it always did.
    for (;;) {
      this.#running = true;
      this.#selfInvalidated = false;
      this.#runs += 1;
      /** @type {unknown} */
      let teardown;
      try {
        teardown = this.track(this.#invoke);
      } catch (err) {
        this.#running = false;
        if (err instanceof NoValueError) {
          // Not an error so much as "not yet". The effect stays subscribed to
          // whatever it did manage to read, and will be told when that moves.
          this.#requeueIfStale();
          return;
        }
        if (this.#onError) {
          this.#onError(err);
          this.#settleOrGiveUp();
          this.#requeueIfStale();
          return;
        }
        throw err;
      }
      this.#running = false;
      if (typeof teardown === "function") {
        if (this.#disposed) {
          // The run failed itself on the way through — `context.fail`, called
          // before it returned — so the sweep that would have run this teardown
          // has already been and gone. Registering it now would park it on a
          // list nothing reads again, which for a run that took a subscription
          // means the subscription stays.
          /** @type {() => void} */ (teardown)();
        } else {
          // Registered after the run, because `track` clears the previous run's
          // cleanups on the way in.
          this.onCleanup(/** @type {() => void} */ (teardown));
        }
      }
      this.#settleOrGiveUp();
      if (this.#disposed || this.state === CLEAN) {
        return;
      }
      // Something invalidated this effect while it was running — its own
      // write, most likely. Go round again.
      this.state = CLEAN;
    }
  }

  /**
   * Take a failure the run reported after the fact, and land it where a thrown
   * one lands.
   *
   * `onError` first, and then the effect carries on — the same bargain the
   * synchronous path strikes, where a handled exception does not stop the
   * effect. Without one there is no stack left to throw into, so the effect
   * fails instead: cleanups run, whatever reads or watches it is told, and it
   * stops for good rather than sitting disconnected and still queueable.
   *
   * @param {unknown} err
   * @returns {void}
   */
  #reportFailure(err) {
    if (this.#disposed) {
      return;
    }
    if (this.#onError) {
      this.#onError(err);
      return;
    }
    this.fail(err);
    this.dispose();
  }

  /**
   * Hand a still-stale effect back to the queue.
   *
   * For the paths that give up on a run rather than finishing it: the mark is
   * real and nothing else is going to act on it, but retrying immediately
   * would just fail again, so the queue gets to decide when.
   *
   * @returns {void}
   */
  #requeueIfStale() {
    if (!this.#disposed && this.state !== CLEAN) {
      updateQueue.enqueue(this);
    }
  }

  /**
   * An effect that leaves itself work to redo gets to try again — but not
   * forever. A run that settles clears the count; a run that does not, on top
   * of a long enough streak of them, is a loop that is not going to converge.
   *
   * This catches the transitive case too — two effects that write what the
   * other reads, where the second one's write lands while the first is still
   * running. `UpdateQueue`'s per-pass cap is the backstop for a cycle whose
   * hops never nest.
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
        `Effect "${this.#name}" was invalidated by its own run on ` +
          `${MAX_SELF_INVALIDATIONS} consecutive runs without settling. Something it ` +
          `writes is read by something that writes what it reads; no channel order can ` +
          `resolve that, so the cycle itself has to be broken.`,
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

/**
 * An effect that lives exactly as long as the computation it is built in.
 *
 * An effect is a root of demand: nothing reads it, so nothing lets go of it,
 * and it keeps everything it reads awake until somebody disposes it. Which
 * makes "somebody" the only real question, and the surrounding computation is
 * almost always the answer — the effect was built to serve a region of the
 * graph and has no business outliving that region. Pairing the two here means
 * the caller never holds the handle only to dispose it later, and never
 * forgets to.
 *
 * Called with no computation active there is nothing to pair with, so
 * `onCleanup` says so and disposes on the spot rather than leaving an effect
 * nobody can reach. Use `new Effect` where the lifetime really is the
 * caller's.
 *
 * @param {EffectRun} run
 * @param {EffectOptions} [options]
 * @returns {Effect}
 */
export function useEffect(run, options) {
  const instance = new Effect(run, options);
  onCleanup(() => instance.dispose());
  return instance;
}

export default Effect;
