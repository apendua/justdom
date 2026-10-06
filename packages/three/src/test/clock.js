/**
 * Stand in for `performance.now` with a clock the test moves, so that how
 * long anything has waited, a panel on its channel, a loading frame on its
 * minimum time, an animation clock on its account, is up to the test and
 * not to how fast the machine runs it. Each of those reads `performance.now`
 * at the time of the call, so each reads this. Give it back with `restore`,
 * in a `finally`. Its own module, apart from `portalHarness.js`, since that
 * one installs a frame queue a test of the animation clock does not want.
 *
 * @returns {{
 *   now: () => number,
 *   set: (ms: number) => void,
 *   advance: (ms: number) => void,
 *   restore: () => void,
 * }}
 */
export function fakeClock() {
  const originalNow = performance.now;
  let clock = 0;
  performance.now = () => clock;
  return {
    now: () => clock,
    set: (ms) => {
      clock = ms;
    },
    advance: (ms) => {
      clock += ms;
    },
    restore: () => {
      performance.now = originalNow;
    },
  };
}
