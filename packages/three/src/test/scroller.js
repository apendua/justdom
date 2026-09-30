/**
 * jsdom lays nothing out and never scrolls, so a scroller has to be
 * described: how much fits, how much there is, and where it currently sits.
 *
 * @param {HTMLElement} element
 * @param {{ client: number, scroll: number }} size
 */
export function describeScroller(element, { client, scroll }) {
  let top = 0;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => client },
    scrollHeight: { configurable: true, get: () => scroll },
    clientWidth: { configurable: true, get: () => client },
    scrollWidth: { configurable: true, get: () => client },
    scrollTop: {
      configurable: true,
      get: () => top,
      // Browsers clamp, and so does the list at the ends of its travel.
      set: (value) => {
        top = Math.max(0, Math.min(value, scroll - client));
      },
    },
  });
}
