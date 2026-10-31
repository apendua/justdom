/**
 * What a benchmark counts, and why it counts rather than times.
 *
 * Wall clock on this workload is not trustworthy on its own. Measuring the
 * same commit twice in this repository has produced 3.9 ms, 66 ms and 116 ms
 * for one figure — a software rasterizer, a shared machine and a JIT that
 * warms up differently each run will do that. Every conclusion drawn here is
 * therefore drawn first from a *count*: how many times the mirror asked the
 * browser to lay out, how many times it read a computed style, how many
 * glyphs it drew. Those are identical run to run, so a change of one is a
 * real change, and no amount of noise can manufacture or hide it.
 *
 * Time is still reported, because a count can fall while a frame gets slower.
 * But it is reported as *frame gaps under a constant stimulus* rather than as
 * the duration of any particular call — see `frames.js` for why that
 * distinction is the whole ballgame for work that moves between a mutation
 * and the frame that follows it.
 */

/**
 * The page-side half: installed before any application code runs, so that
 * every call it wraps is wrapped from the first one.
 *
 * Kept as a plain function that is serialized into the page rather than an
 * imported module, because `addInitScript` runs in a world where this file's
 * imports do not exist.
 *
 * @param {{ styleReads: boolean }} options
 */
export function installCounters({ styleReads }) {
  /**
   * @type {Record<string, number>}
   */
  const counters = {
    // Every one of these forces the browser to have a current layout. They
    // are the mirror's dominant cost on a scroll and the number a deferral
    // is trying to move: the same rect asked for twice between two frames is
    // exactly the waste that batching removes.
    getBoundingClientRect: 0,
    // The call itself is cheap and already cached behind a signal; what is
    // not cheap is reading properties off the live declaration it returns,
    // which is where a computed style is actually resolved.
    getComputedStyle: 0,
    styleProperty: 0,
    // Text rasterization. A texture rebuild is the most expensive single
    // thing a mutation can cause, and it is invisible to the other counters.
    fillText: 0,
    measureText: 0,
    canvasCreated: 0,
    // Layout thrash, which is what a deferral is really for: a read that
    // follows a write with no frame in between makes the browser lay out
    // again. Counted by watching for a read that is the first one after any
    // style write.
    thrash: 0,
  };
  // Whether a style has been written since the last layout read. A read that
  // finds this set is a forced synchronous layout that a batched design
  // would not have performed.
  let dirty = false;

  const rect = Element.prototype.getBoundingClientRect;
  /**
   * The last rect each element was told. In a steady state the mirror is the
   * only thing measuring, so this is precisely what it believes — which is
   * what makes a coherence check possible without reaching into the package.
   *
   * @type {WeakMap<Element, DOMRect>}
   */
  const believed = new WeakMap();
  /** @type {Set<Element>} */
  const measured = new Set();
  Element.prototype.getBoundingClientRect = function counted() {
    counters.getBoundingClientRect += 1;
    if (dirty) {
      counters.thrash += 1;
      dirty = false;
    }
    const value = rect.call(this);
    believed.set(this, value);
    measured.add(this);
    return value;
  };

  // Style writes go through `style.setProperty` and the camel-cased setters
  // alike; the declaration object is the same either way, so one trap on the
  // prototype's setter path catches both.
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function marked(...args) {
    dirty = true;
    return setProperty.apply(this, args);
  };
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function marked(...args) {
    dirty = true;
    return setAttribute.apply(this, args);
  };

  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (...args) => {
    counters.getComputedStyle += 1;
    const declaration = computed(...args);
    if (!styleReads) {
      return declaration;
    }
    // Off by default. A proxy around a live declaration is the only way to
    // see property reads, and it is also a per-read allocation the real
    // thing does not pay — so it tells the truth about *how many* and lies
    // about *how long*. Turn it on to compare counts; leave it off when the
    // frame gaps are what matter.
    return new Proxy(declaration, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value === "function") {
          return value.bind(target);
        }
        if (typeof key === "string") {
          counters.styleProperty += 1;
        }
        return value;
      },
    });
  };

  const create = document.createElement.bind(document);
  document.createElement = (tag, ...rest) => {
    if (tag === "canvas") {
      counters.canvasCreated += 1;
    }
    return create(tag, ...rest);
  };

  const context = CanvasRenderingContext2D.prototype;
  const fill = context.fillText;
  context.fillText = function counted(...args) {
    counters.fillText += 1;
    return fill.apply(this, args);
  };
  const measure = context.measureText;
  context.measureText = function counted(...args) {
    counters.measureText += 1;
    return measure.apply(this, args);
  };

  Object.assign(globalThis, {
    __bench: {
      counters,
      /** @returns {Record<string, number>} */
      snapshot: () => ({ ...counters }),
      /**
       * @param {Record<string, number>} before
       * @returns {Record<string, number>}
       */
      since: (before) =>
        Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, v - before[k]])),
      /**
       * Whether what the mirror last measured is still what the browser
       * would say. Not a performance question, and the reason it lives in
       * the benchmark: a design that lets caches run behind the DOM is the
       * most likely thing to reintroduce the stale-rect bug this codebase
       * just fixed, and a run that only got faster would never notice.
       *
       * The raw method is used for the comparison so that checking does not
       * itself refresh what is being checked.
       *
       * @returns {{ checked: number, mismatches: object[] }}
       */
      coherence: () => {
        const mismatches = [];
        let checked = 0;
        for (const element of measured) {
          if (!element.isConnected) {
            continue;
          }
          const held = believed.get(element);
          if (!held) {
            continue;
          }
          checked += 1;
          const live = rect.call(element);
          if (
            Math.abs(held.width - live.width) > 0.5 ||
            Math.abs(held.height - live.height) > 0.5
          ) {
            mismatches.push({
              tag: element.tagName,
              held: [Math.round(held.width), Math.round(held.height)],
              live: [Math.round(live.width), Math.round(live.height)],
            });
          }
        }
        return { checked, mismatches: mismatches.slice(0, 8) };
      },
    },
  });
}
