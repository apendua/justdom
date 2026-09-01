import ReactiveNode from "./Node.js";
import {
  CLEAN,
  CHECK,
  DIRTY,
  CircularDependencyError,
  NoValueError,
  activeChannel,
  addDependency,
  onCleanup,
  withChannel,
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
 *   is watching it is told, and it stops. Called from *inside* a run rather
 *   than after it, that ending waits for the run to unwind, so the rest of
 *   the body still runs and what it builds is still owned; `throw` is the way
 *   to stop a run where it stands.
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
 * The rule `EffectRun`'s `unknown` cannot state on its own: a run may evaluate
 * to anything at all, but if that anything is a *function* it is going to be
 * called as a teardown, with no arguments, so it had better not need any.
 *
 * Written as a conditional rather than as `void | (() => void)` because that
 * union costs the one-liner the `unknown` was chosen for — `() => list.push(x)`
 * evaluates to a number, and a number is not a `void`. This leaves every
 * non-function return exactly as permissive as it was and narrows only the
 * branch that has a contract to break. Intersected with `T` at the call site,
 * which is what keeps `T` inferrable: a bad teardown is then asked to be both
 * itself and the sentence below, and the failure prints the rule.
 *
 * `Effect` itself cannot carry this — a constructor takes no type parameter of
 * its own — so `#execute` checks the same thing at runtime, for `new Effect`
 * and for callers who are not looking at types at all.
 *
 * @template T
 * @typedef {T extends (...args: infer A) => unknown
 *   ? A extends readonly []
 *     ? T
 *     : "an effect's teardown is called with no arguments, so it must take none"
 *   : T} Teardown
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
 *   re-runs in, and which channel its runs build into. Fixed for the life of
 *   the effect.
 * @property {(err: unknown) => void} [onError] where this effect's failures
 *   land **once it stands**. Two kinds arrive, and `isDisposed` tells them
 *   apart. A failure of a *run* — the body throwing, or the run reporting one
 *   through `context.fail` — is handled here and the effect carries on. A
 *   failure of the *effect* — a dependency that died, `fail()` — has already
 *   ended it by the time this is called: cleanups have run, and this is the
 *   notification, heard here only when no dependent or error-handling
 *   subscriber heard it first. Without an `onError`, a thrown exception comes
 *   back out of whatever was draining the queue, a reported failure fails the
 *   effect outright, and a failure of the effect that nothing hears is either
 *   rethrown from the run it interrupted or reported as unhandled.
 *
 *   Nothing that arrives while the *constructor* is still on the stack comes
 *   here — see `#handler`. Construction reports failure the way construction
 *   always reports it, by throwing, whether or not this was passed.
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

  /**
   * Whether the constructor is still on the stack.
   *
   * The one window in an effect's life where a failure has somewhere better
   * to go than `onError`: the caller who is building this effect, on a stack
   * that is still standing. See `#handler`.
   *
   * @type {boolean}
   */
  #constructing = false;

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
   * A failure that will end this effect, held until the run it arrived during
   * has unwound.
   *
   * Ending an effect disposes it, and disposing it sweeps its cleanups — so
   * doing that from the middle of a run leaves the rest of the run building
   * against a corpse. Everything it registers after that point lands on a
   * fresh list that nothing will ever sweep again: a `useEffect` that outlives
   * the effect that owns it and goes on running, a subscription nobody
   * unsubscribes. The run is going to unwind in a moment either way, so the
   * ending waits for it, and then takes the whole run down at once.
   *
   * Distinct from `#unheardFailure` below, which is the *other* half of the
   * same trip: this one is a failure not yet applied, that one is a failure
   * already applied that nobody heard.
   *
   * @type {{ value: unknown } | null}
   */
  #pendingFailure = null;

  /**
   * Whether `#execute` is applying a pending failure right now.
   *
   * `handleUnheardFailure` reads it. Delivering the news of a death from
   * inside the death itself would mean throwing out of `Node.fail`'s observer
   * loop with dependents left un-notified, so the news is parked instead and
   * `#execute` — which is one frame down and has nothing left to do — hands
   * it on.
   *
   * @type {boolean}
   */
  #ending = false;

  /**
   * The death of this effect, which nobody heard. Parked rather than
   * delivered on the spot, because the spot is `Node.fail`'s observer loop
   * with dependents still to notify, and delivery can throw: during
   * construction it always does, and an `onError` is entitled to. `#execute`
   * picks it up as soon as the ending is complete; see
   * `handleUnheardFailure`.
   *
   * @type {{ value: unknown } | null}
   */
  #unheardFailure = null;

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
   * given: one wrapper, built once, that hands the run its context and puts
   * the run in this effect's own channel.
   *
   * The channel matters because a run *builds* things — a nested effect, a
   * region, anything reached through a helper that takes no channel — and
   * those belong to the region this effect belongs to. On the first run that
   * happens anyway: construction is inside whatever `withChannel` the caller
   * was in, and `activeChannel` still points at it. A re-run comes off a
   * queue with no such caller on the stack, so without this the same
   * `useEffect(...)` line yields the region's channel the first time and the
   * default channel every time after — half an update applied as soon as it
   * can be and the other half a frame later, which is the exact failure
   * `activeChannel` exists to prevent.
   *
   * @type {() => unknown}
   */
  #invoke = () => withChannel(this.#channel, () => this.#run(this.#context));

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
    this.#constructing = true;
    try {
      this.#execute();
    } catch (err) {
      // An effect that could not get through its first run has no business
      // staying subscribed to what it managed to read on the way.
      this.dispose();
      throw err;
    } finally {
      this.#constructing = false;
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
        this.#applyPendingFailure();
        const unheard = this.#unheardFailure;
        this.#unheardFailure = null;
        if (err instanceof NoValueError) {
          if (unheard) {
            // The run was interrupted by the effect failing and *then* hit a
            // "not yet" — but a failed effect has nothing to wait for, so the
            // failure is the news, not the missing value.
            this.#deliverUnheard(unheard.value);
            return;
          }
          // Not an error so much as "not yet". The effect stays subscribed to
          // whatever it did manage to read, and will be told when that moves.
          this.#requeueIfStale();
          return;
        }
        // A parked failure, if there was one, is dropped in favour of the
        // throw: reading the very dependency whose death was parked throws
        // the same error, and delivering both would hand one failure to the
        // handler twice.
        const onError = this.#handler();
        if (onError) {
          onError(err);
          this.#settleOrGiveUp();
          this.#requeueIfStale();
          return;
        }
        throw err;
      }
      this.#running = false;
      try {
        if (typeof teardown === "function") {
          if (teardown.length > 0) {
            // `length` counts what a function *requires*: a rest parameter or a
            // default makes it zero, and both of those can be called with
            // nothing, so this fires on exactly the functions that cannot. Which
            // in practice means one returned by accident — a method reference, a
            // callback meant for somebody else — rather than a teardown.
            throw new Error(
              `Effect "${this.#name}" returned a teardown taking ${teardown.length} argument(s). ` +
                `A teardown is called with none, so this one can never be given what it asks for.`,
            );
          }
          if (this.#disposed) {
            // Disposed on the way through, by something that is not a failure —
            // the run calling `dispose()` on its own effect — so the sweep that
            // would have run this teardown has already been and gone.
            // Registering it now would park it on a list nothing reads again,
            // which for a run that took a subscription means the subscription
            // stays. A failure does not get here: it waits in `#pendingFailure`
            // to be applied below, *after* this teardown is registered —
            // whether the run leaves by the `catch` or falls through it —
            // precisely so that the sweep pays it.
            /** @type {() => void} */ (teardown)();
          } else {
            // Registered after the run, because `track` clears the previous
            // run's cleanups on the way in.
            this.onCleanup(/** @type {() => void} */ (teardown));
          }
        }
      } catch (err) {
        // Settling the teardown threw: one that takes arguments is refused
        // above, and one called here because the run disposed its own effect
        // can throw on its own account.
        //
        // Two things still have to happen before that exception is allowed to
        // leave. The ending is not optional — an effect left holding an
        // unapplied failure is a zombie, not disposed, still queueable, still
        // subscribed to everything it read. And neither is saying what it
        // died of: the delivery below is what this exception would otherwise
        // jump straight over, which is how a death reaches `onError` at all.
        this.#applyPendingFailure();
        this.#reportUnheardDeath();
        throw err;
      }
      // The run has unwound and its teardown is settled, so a failure that has
      // been waiting for exactly that can now end the effect — sweeping this
      // run's teardown along with everything else the run registered.
      this.#applyPendingFailure();
      if (this.#unheardFailure) {
        // The effect has ended and nobody heard — see `handleUnheardFailure`.
        // The run has unwound and its teardown is settled, so the failure can
        // finally travel: to `onError`, or up the stack that is still here —
        // the constructor for a first run, the drain for a queued one.
        const unheard = this.#unheardFailure;
        this.#unheardFailure = null;
        this.#deliverUnheard(unheard.value);
        return;
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
   * Failing an effect stops it. `fail` itself only lets go of the edges —
   * which is the whole of it for a node that something *reads*, since a
   * `Derived` nobody reads is already inert. An effect is not read: it is a
   * root of demand with a slot in a queue, so an effect that had let go of
   * everything and still answered `isDisposed` with `false` was one nothing
   * would ever run and nothing would ever say had stopped.
   *
   * Here rather than in `#reportFailure` because a failure arrives from two
   * directions — the run reporting one, and one propagating down from
   * something the effect reads — and both of them end the effect. Which is
   * also why the deferral below is here: both directions can arrive mid-run,
   * and both would otherwise sweep the running effect's cleanups out from
   * under it.
   *
   * @param {unknown} err
   * @returns {void}
   */
  fail(err) {
    if (this.#running) {
      // Not yet. See `#pendingFailure`: ending the effect here would sweep
      // its cleanups out from under a run that is still going, and orphan
      // whatever that run builds from this point on. `#execute` applies it
      // the moment the run unwinds.
      this.#pendingFailure = this.#pendingFailure ?? { value: err };
      return;
    }
    super.fail(err);
    this.dispose();
  }

  /**
   * Apply a failure that has been waiting for its run to unwind: tell
   * everyone, then stop.
   *
   * `#ending` is up for the duration so that a death nobody hears is parked
   * rather than delivered from inside `Node.fail`'s observer loop — the loop
   * has dependents left to notify, and delivery is entitled to throw.
   *
   * @param {unknown} err
   * @returns {void}
   */
  #endWithFailure(err) {
    try {
      this.#ending = true;
      super.fail(err);
    } finally {
      // `super.fail` notifies observers, and an observer's `error` is
      // arbitrary code that may throw — the same "delivery is entitled to
      // throw" this class relies on elsewhere. Disposing from the `finally`
      // is what stops that throw leaving a corpse that still says it is
      // alive: `super.fail` has already recorded the failure and let go of
      // every edge, so an effect that skipped this line would answer
      // `isDisposed` with `false` and `isLive` with `true` for good, keep its
      // slot in the queue, and be re-enqueued and re-run by `markStale` on a
      // graph it has already parted ways with.
      this.#ending = false;
      this.dispose();
    }
  }

  /**
   * A failure of this effect that no dependent and no error-handling
   * subscriber heard. The base class would report it as unhandled; an effect
   * has two listeners the observer list cannot see, and this is where they
   * come in — which is what makes `onError` the *one* place to catch an
   * effect's failures, however they arrive.
   *
   * Reached only from inside `#endWithFailure`, since `fail` defers while a
   * run is on the stack and this is what `Node.fail`'s observer loop calls
   * when it finds nobody listening. So the failure is parked and `#execute`
   * delivers it a frame down: delivery can throw — while the constructor is
   * on the stack there is no handler to consult and the throw *is* the
   * delivery, and an `onError` is entitled to throw in its own right — and
   * an exception out of the observer loop would leave the dependents behind
   * it un-notified.
   *
   * Otherwise `onError` is told directly — the effect is already ended, so
   * this is notification, not rescue — and only an effect with no handler to
   * consult and no run on the stack falls through to the report.
   *
   * @param {unknown} err
   * @returns {void}
   */
  handleUnheardFailure(err) {
    if (this.#ending) {
      this.#unheardFailure = this.#unheardFailure ?? { value: err };
      return;
    }
    const onError = this.#handler();
    if (onError) {
      onError(err);
      return;
    }
    super.handleUnheardFailure(err);
  }

  /**
   * Land a parked failure now that the run it interrupted has unwound:
   * `onError` if there is one, and otherwise up the stack that provoked the
   * run — which for a first run is the constructor, making a dependency that
   * dies on the way in indistinguishable from a body that threw.
   *
   * @param {unknown} err
   * @returns {void}
   */
  #deliverUnheard(err) {
    const onError = this.#handler();
    if (onError) {
      onError(err);
      return;
    }
    throw err;
  }

  /**
   * Where a failure goes, or `undefined` when it has to travel the stack.
   *
   * `onError` is the effect's *ongoing* failure channel, and an effect only
   * has one of those once it stands. While the constructor is still running,
   * every failure — the body throwing, `context.fail`, a dependency dying on
   * the way in — belongs to the caller who is building this effect, and the
   * way to hand it to them is to throw: `#execute` lets it out, and the
   * constructor disposes the half-built effect on its way past.
   *
   * Which is what an effect with no `onError` has always done. What this adds
   * is that passing one no longer changes it. Before, `onError` decided two
   * unrelated things at once — where a failure is reported, and whether a
   * failure during mounting is fatal — so a caller who wanted the second
   * default back had to restore it by hand, with a mutable `standing` flag
   * and a rethrow, at every site that mounts something. `just` and
   * `useEffects` both carried that; neither does now.
   *
   * It also makes the obvious wiring sound. `onError: (err) => effect.fail(err)`
   * closes over a binding its own initialiser is still evaluating, so it used
   * to work only for as long as nothing called it during the first run —
   * a property of the run's body, not something the effect could promise.
   * A handler that cannot be reached before the constructor returns can
   * promise it.
   *
   * @returns {((err: unknown) => void) | undefined}
   */
  #handler() {
    return this.#constructing ? undefined : this.#onError;
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
    const onError = this.#handler();
    if (onError) {
      onError(err);
      return;
    }
    this.fail(err);
  }

  /**
   * Deliver a death nobody heard, on the way out of a run that is already
   * unwinding with an exception of its own.
   *
   * Like `#deliverUnheard`, except that this one may not throw: an exception
   * is already travelling, and a second cannot travel beside it — it would
   * replace the first, so the caller would be told about the effect's death
   * instead of the bad teardown that caused this exit, and never both. So a
   * handler is called if there is one, and otherwise the death is *reported*
   * rather than thrown, which is the only way left to say it out loud. That
   * is a weaker outcome than the constructor rethrow an unhandled death
   * usually gets, and it is confined to a run that managed to fail twice.
   *
   * @returns {void}
   */
  #reportUnheardDeath() {
    const unheard = this.#unheardFailure;
    if (!unheard) {
      return;
    }
    this.#unheardFailure = null;
    const onError = this.#handler();
    if (onError) {
      onError(unheard.value);
      return;
    }
    super.handleUnheardFailure(unheard.value);
  }

  /**
   * End the effect, if a failure has been waiting for this run to unwind.
   *
   * Called on both of `#execute`'s exits, because a run can report a failure
   * and then throw as well as report one and return, and the failure is
   * terminal either way.
   *
   * @returns {void}
   */
  #applyPendingFailure() {
    const pending = this.#pendingFailure;
    if (!pending) {
      return;
    }
    this.#pendingFailure = null;
    this.#endWithFailure(pending.value);
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
 * @template T
 * @param {(context: EffectContext) => T & Teardown<T>} run
 * @param {EffectOptions} [options]
 * @returns {Effect}
 */
export function effect(run, options) {
  return new Effect(run, options);
}

/**
 * A dependency that never marks the computation stale: it forwards only the
 * failure of what it watches. Liveness without listening.
 *
 * @param {{ subscribe: ReactiveNode['subscribe'] }} subscribable
 * @returns {{ subscribe: ReactiveNode['subscribe'] }}
 */
export function failuresOf(subscribable) {
  return {
    subscribe: (observer) =>
      subscribable.subscribe({
        error: (err) => observer.error?.(err),
      }),
  };
}

/**
 * @typedef {EffectOptions & {
 *   standalone?: boolean
 * }} UseEffectOptions `standalone` opts out of the failure edge below: the
 *   effect still lives and dies with the computation, but a failure of its
 *   own once it stands is its own — heard by its `onError` or a subscriber,
 *   and reported as unhandled otherwise, never carried to the computation.
 *   (A failure during the first run is on the builder's stack either way.)
 *   For the rare inner effect whose death should not take its region with it.
 */

/**
 * An effect that lives exactly as long as the computation it is built in —
 * and whose failure the computation hears.
 *
 * An effect is a root of demand: nothing reads it, so nothing lets go of it,
 * and it keeps everything it reads awake until somebody disposes it. Which
 * makes "somebody" the only real question, and the surrounding computation is
 * almost always the answer — the effect was built to serve a region of the
 * graph and has no business outliving that region. Pairing the two here means
 * the caller never holds the handle only to dispose it later, and never
 * forgets to.
 *
 * Disposal alone is not the whole tie, because an effect can die on its own:
 * a dependency that errors fails it down the push path, which never throws —
 * so without more, the effect stops, the computation is never told, and the
 * only trace is an unhandled-failure report. Hence the failure edge: the
 * computation takes `failuresOf(instance)` as a dependency, so an inner
 * effect's death is the computation's failure, exactly as a dead node the
 * computation reads would be. The edge hears nothing else — no values, no
 * invalidations. It carries only failures that arrive once the effect
 * stands; one that lands during the *first run* never needs it, because the
 * constructor rethrows it onto the stack this very call is on, the same way
 * a body that threw would arrive.
 *
 * Called with no computation active there is nothing to pair with, so
 * `onCleanup` says so and disposes on the spot rather than leaving an effect
 * nobody can reach. Use `new Effect` where the lifetime really is the
 * caller's.
 *
 * @template T
 * @param {(context: EffectContext) => T & Teardown<T>} run
 * @param {UseEffectOptions} [options]
 * @returns {Effect}
 */
export function useEffect(run, options) {
  const { standalone = false, ...effectOptions } = options ?? {};
  const instance = new Effect(run, effectOptions);
  onCleanup(() => instance.dispose());
  if (!standalone) {
    addDependency(failuresOf(instance));
  }
  return instance;
}

export default Effect;
