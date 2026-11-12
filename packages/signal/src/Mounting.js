import { Effect, assertTeardown } from "./Effect.js";
import { NoValueError, activeChannel, callWithComputation, withComputation } from "./core.js";
import { defaultChannel } from "./scheduler.js";

/**
 * @import { Dependency } from "./core.js";
 * @import { EffectContext, EffectOptions } from "./Effect.js";
 * @import UpdateChannel from "./UpdateChannel.js";
 * @import { EntityEffect } from "./types.js";
 */

/**
 * The entries of one `just` or one `mount`, mounted for one holder.
 *
 * Each entry behaves as the body of its own `Effect`, and most entries never
 * need one. A static `set`, a `children`, an event listener: they run once,
 * read nothing reactive, and at most leave a teardown behind. An `Effect`
 * built for such an entry has nothing to wait for. So an entry runs here
 * first, with the mounting as the computation that is evaluating:
 *
 * - A teardown the entry registers is kept by the mounting, in the entry's
 *   place, and runs when the mounting is taken down.
 * - The first dependency the entry reads builds its `Effect`, there and then,
 *   with the run on the stack as the effect's first run (`Effect.adopt`).
 *   The teardowns registered so far move to the effect, and so does
 *   everything the rest of the run reads and registers. From its second run
 *   on, the entry is an effect like any other.
 *
 * Nothing runs twice, and an entry is not asked what kind it is: whether it
 * gets an effect is decided by what its run did.
 *
 * The mounting hands its entries their context, since an entry with no
 * effect has none of its own. Its `fail` does what an effect's does: called
 * while the entry's first run is on the stack, the failure ends the mounting
 * once the run has unwound, and called later, it goes to the holder's
 * `onError`. Called after the mounting was taken down, it does nothing.
 *
 * An entry's effect is built in the channel the mounting was built in,
 * wherever in the entry its first read happens to sit.
 *
 * @template T
 */
export class Mounting {
  /**
   * Where a failure goes once the mounting stands.
   *
   * @type {(err: unknown) => void}
   */
  #onError;

  /**
   * What taking the mounting down owes, in the order of the entries: a
   * teardown of an entry that has no effect, or an entry's effect. `null`
   * until there is one, and again once they are paid.
   *
   * @type {Array<Effect | (() => void)> | null}
   */
  #owed = null;

  /**
   * The entry that is running, and the entity it runs on. Kept for the
   * effect an entry may turn out to need.
   *
   * @type {EntityEffect<T> | null}
   */
  #entry = null;

  /** @type {T | undefined} */
  #entity;

  /**
   * Where in `#owed` the teardowns of the running entry start.
   *
   * @type {number}
   */
  #first = 0;

  /**
   * The effect of the running entry, once it has read something.
   *
   * @type {Effect | null}
   */
  #effect = null;

  /**
   * A failure the running entry reported through `fail`, waiting for the run
   * to unwind.
   *
   * @type {{ value: unknown } | null}
   */
  #pending = null;

  /**
   * What every effect of this mounting is built with. Made for the first
   * one.
   *
   * @type {EffectOptions | null}
   */
  #options = null;

  /**
   * The channel the mounting was built in, which is the channel of its
   * effects. An effect built on its own takes the channel that is active
   * when it is built, and an entry's is built at its first read, which may
   * sit inside a `withChannel` of the entry's own.
   *
   * @type {UpdateChannel}
   */
  #channel = /** @type {UpdateChannel | null} */ (activeChannel) ?? defaultChannel;

  /**
   * Whether the mounting was taken down. A failure reported after that is
   * dropped.
   *
   * @type {boolean}
   */
  #ended = false;

  /**
   * What an entry is handed on its first run: `fail`, and nothing else of
   * the mounting.
   *
   * @type {EffectContext}
   */
  #context = { fail: (err) => this.#fail(err) };

  /**
   * @param {(err: unknown) => void} onError
   */
  constructor(onError) {
    this.#onError = onError;
  }

  /**
   * Report a failure that happened after the entry's run returned.
   *
   * @param {unknown} err
   * @returns {void}
   */
  #fail(err) {
    if (!this.#entry) {
      // No run on the stack, so the mounting stands, or has gone. This is
      // where the `onError` of an entry's effect lands as well. A mounting
      // that has gone has no holder left to tell: the failure of something
      // that was taken down is dropped, as a closed subscription drops it.
      if (!this.#ended) {
        this.#onError(err);
      }
      return;
    }
    if (this.#effect) {
      if (!this.#effect.isDisposed) {
        this.#effect.fail(err);
      }
      return;
    }
    this.#pending = this.#pending ?? { value: err };
  }

  /**
   * Run one entry on `entity`, and keep what it leaves behind.
   *
   * A failure of the run is thrown, with what the run had registered taken
   * down again: the entry throwing, the entry reporting a failure through
   * `fail`, or a dependency dying on the way in.
   *
   * @param {EntityEffect<T>} entry
   * @param {T} entity
   * @returns {void}
   */
  mount(entry, entity) {
    this.#entry = entry;
    this.#entity = entity;
    this.#first = this.#owed ? this.#owed.length : 0;
    /** @type {unknown} */
    let teardown;
    try {
      teardown = callWithComputation(this, entry, entity, this.#context);
    } catch (err) {
      const effect = this.#finish();
      if (effect) {
        // Throws, unless the effect has something to wait for.
        effect.settleAdopted(true, err);
        return;
      }
      const pending = this.#pending;
      this.#pending = null;
      if (err instanceof NoValueError && !pending) {
        // "Not yet", from a run that read nothing: there is nothing whose
        // change would bring the value, so the entry is done. What it
        // registered before it gave up is still owed.
        return;
      }
      this.#abandon();
      // A reported failure gives way to a thrown one, as in an effect, and
      // is the news when the throw was only "not yet".
      throw err instanceof NoValueError && pending ? pending.value : err;
    }
    const effect = this.#finish();
    if (effect) {
      effect.settleAdopted(false, teardown);
      return;
    }
    const pending = this.#pending;
    this.#pending = null;
    if (typeof teardown === "function") {
      try {
        assertTeardown("just", teardown);
      } catch (err) {
        this.#abandon();
        throw err;
      }
      this.#owe(/** @type {() => void} */ (teardown));
    }
    if (pending) {
      this.#abandon();
      throw pending.value;
    }
  }

  /**
   * Take the mounting down: every teardown runs and every effect is
   * disposed, in the order of the entries. One that throws does not strand
   * the ones behind it. They all go, and the first failure is raised once
   * they have.
   *
   * @returns {void}
   */
  unsubscribe() {
    this.#ended = true;
    this.#release(0);
  }

  /**
   * Record that the running entry read `dependency`. The first one is what
   * gives the entry its effect.
   *
   * @param {Dependency} dependency
   * @returns {void}
   */
  addDependency(dependency) {
    (this.#effect ?? this.#adopt()).addDependency(dependency);
  }

  /**
   * Register a teardown of the running entry.
   *
   * @param {() => void} fn
   * @returns {void}
   */
  onCleanup(fn) {
    if (this.#effect) {
      this.#effect.onCleanup(fn);
    } else {
      this.#owe(fn);
    }
  }

  /**
   * @param {Effect | (() => void)} item
   * @returns {void}
   */
  #owe(item) {
    // A literal rather than a push onto `[]`, which V8 would give room for
    // seventeen: most mountings are owed one or two.
    if (this.#owed) {
      this.#owed.push(item);
    } else {
      this.#owed = [item];
    }
  }

  /**
   * Build the running entry's effect, around the run that is on the stack.
   *
   * @returns {Effect}
   */
  #adopt() {
    const entry = /** @type {EntityEffect<T>} */ (this.#entry);
    const entity = /** @type {T} */ (this.#entity);
    if (!this.#options) {
      // `onError` hears a later run failing, and the effect itself failing
      // when a dependency dies. It hears none of that during the first run:
      // an effect whose constructor has not returned throws instead, which
      // is what `settleAdopted` does.
      this.#options = { name: "just", onError: this.#context.fail, channel: this.#channel };
    }
    const effect = Effect.adopt((context) => entry(entity, context), this.#options);
    // A failure the run reported before this read is the effect's now. The
    // effect is running, so it keeps the failure until the run has unwound,
    // as it would have had the effect been there to take the report.
    const pending = this.#pending;
    if (pending) {
      this.#pending = null;
      effect.fail(pending.value);
    }
    // What the run has registered so far is the run's own, to be paid before
    // the entry runs again, so it goes with the effect.
    const owed = this.#owed;
    if (owed) {
      for (let index = this.#first; index < owed.length; index += 1) {
        effect.onCleanup(/** @type {() => void} */ (owed[index]));
      }
      owed.length = this.#first;
    }
    this.#owe(effect);
    this.#effect = effect;
    return effect;
  }

  /**
   * The running entry's run has unwound. Hands back its effect, if it has
   * one.
   *
   * @returns {Effect | null}
   */
  #finish() {
    const effect = this.#effect;
    this.#entry = null;
    this.#entity = undefined;
    this.#effect = null;
    return effect;
  }

  /**
   * Take down what the entry that just failed had registered.
   *
   * @returns {void}
   */
  #abandon() {
    this.#release(this.#first);
  }

  /**
   * Pay what is owed from `start` on.
   *
   * @param {number} start
   * @returns {void}
   */
  #release(start) {
    const owed = this.#owed;
    if (!owed || owed.length <= start) {
      return;
    }
    const items = start === 0 ? owed : owed.splice(start);
    if (start === 0) {
      this.#owed = null;
    }
    // Non-reactive, as a node's own teardowns are: whichever computation
    // happens to be evaluating when the mounting ends has read nothing here.
    withComputation(null, () => {
      /** @type {{ value: unknown } | null} */
      let failure = null;
      for (const item of items) {
        try {
          if (typeof item === "function") {
            item();
          } else {
            item.dispose();
          }
        } catch (err) {
          failure = failure ?? { value: err };
        }
      }
      if (failure) {
        throw failure.value;
      }
    });
  }
}

export default Mounting;
