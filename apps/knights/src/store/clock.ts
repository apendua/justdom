import { fromObservable, interval, toObservable } from "justdom-signal";
import { TIMING_FRAMES_PER_SECOND } from "../constants";

/**
 * The animation clock. Every sprite on the board advances one frame per tick.
 *
 * The original project gave each actor its own `setInterval`; a single shared
 * interval does the same job without scaling the number of timers with the
 * number of actors. The node is what buys that: `interval` is cold, so a
 * subscriber of its own would get a timer of its own, and reading it through
 * a node means one timer however many sprites are mounted — created when the
 * first one reads it, dropped when the last one goes.
 */
export const frames = toObservable(fromObservable(interval(1000 / TIMING_FRAMES_PER_SECOND)));
