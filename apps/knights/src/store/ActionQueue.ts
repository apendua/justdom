import { mutate, store } from "justdom-signal";

interface QueuedAction {
  run: () => void;
  delay: number;
}

/**
 * Runs actions one after another, waiting for the declared delay before each of
 * them. This is what lets a single move be expressed as a script — "walk, land,
 * swing, take the hit, swing back" — while the board renders each step as it
 * happens.
 *
 * It replaces the redux queue middleware of the original project, and keeps its
 * two behaviors: actions run in the order they were pushed, and the step
 * currently being waited for can be cut short without collapsing the rest of
 * the script.
 */
export default class ActionQueue {
  #items: QueuedAction[] = [];
  #pending: QueuedAction | undefined;
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #state = store({ isBusy: false });

  /**
   * True while there is still something scheduled to run.
   */
  public get isBusy(): boolean {
    return this.#state.isBusy;
  }

  /**
   * Schedule an action to run after every action pushed before it, and after
   * waiting for the given delay.
   */
  @mutate()
  public push(delay: number, run: () => void): void {
    this.#items.push({ run, delay });
    if (!this.#pending) {
      this.#next(false);
    }
  }

  /**
   * Run the action that is currently being waited for straight away. The
   * actions queued behind it keep their own delays.
   */
  @mutate()
  public skip(): void {
    const pending = this.#pending;
    if (!pending) {
      return;
    }
    clearTimeout(this.#timeout);
    this.#items.unshift(pending);
    this.#pending = undefined;
    this.#next(true);
  }

  /**
   * Drop everything that has not run yet.
   */
  @mutate()
  public clear(): void {
    clearTimeout(this.#timeout);
    this.#timeout = undefined;
    this.#pending = undefined;
    this.#items = [];
    this.#state.isBusy = false;
  }

  #next(noDelay: boolean): void {
    const pending = this.#items.shift();
    this.#pending = pending;
    this.#state.isBusy = pending !== undefined;
    if (!pending) {
      this.#timeout = undefined;
      return;
    }
    this.#timeout = setTimeout(
      () => {
        this.#pending = undefined;
        pending.run();
        this.#next(false);
      },
      noDelay ? 0 : pending.delay,
    );
  }
}
