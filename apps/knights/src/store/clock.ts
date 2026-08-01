import { interval, share } from "rxjs";
import { TIMING_FRAMES_PER_SECOND } from "../constants";

/**
 * The animation clock. Every sprite on the board advances one frame per tick.
 *
 * The original project gave each actor its own `setInterval`; a single shared
 * interval does the same job without scaling the number of timers with the
 * number of actors. It's created lazily and torn down once nothing is mounted,
 * which is what `share` buys us here.
 */
export const frames = interval(1000 / TIMING_FRAMES_PER_SECOND).pipe(share());
