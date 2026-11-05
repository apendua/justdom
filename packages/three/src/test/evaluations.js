import { Derived } from "justdom-signal";

/**
 * Count every reactive evaluation in the process from now on. `track` is
 * the one funnel every evaluation goes through, since it opens the scope
 * a run's reads are recorded against, and it lives on the base class
 * every signal and derived shares. Patching `run` instead, which is not a
 * method of anything, once counted 0 everywhere, which looks exactly like
 * a portal that costs nothing. Set `count` to 0 to start over, and give
 * `track` back with `restore`, in a `finally`.
 *
 * @returns {{ count: number, restore: () => void }}
 */
export function countEvaluations() {
  /** @type {any} */
  const node = Object.getPrototypeOf(Derived.prototype);
  const track = node.track;
  if (typeof track !== "function") {
    throw new Error("Cannot count evaluations: the reactive node has no `track`.");
  }
  const counter = {
    count: 0,
    restore() {
      node.track = track;
    },
  };
  /**
   * @this {unknown}
   * @param {...unknown} args
   * @returns {unknown}
   */
  node.track = function countingTrack(...args) {
    counter.count += 1;
    return track.apply(this, args);
  };
  return counter;
}
