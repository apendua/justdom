/**
 * @import {AnimationClass, MutationBatch, MutationType} from './cache.js';
 */

/**
 * The clock that lets the mirror see CSS animations.
 *
 * Transitions, keyframe animations and Web Animations mutate nothing: the
 * DOM stays byte-identical while the computed style changes over time, so
 * the portal's observer — the mirror's only sense — never fires. But the
 * browser is running those animations anyway, hidden container or not; all
 * the mirror has to do is *sample* while anything is animating, and stop the
 * moment nothing is.
 *
 * Membership comes from the transition/animation events, which bubble to the
 * container; a periodic `getAnimations()` sweep reconciles what events miss
 * (Web Animations fire no CSS events at all, and it can also read keyframes
 * to say which properties an animation actually touches). While the set is
 * non-empty, every frame emits invalidation batches scoped to the animating
 * elements — the same batches a mutation would have produced, so everything
 * downstream just works. An empty set requests no frames: the idle cost of
 * all of this is nothing.
 */

/**
 * How an animated property ranks for invalidation. Paint asks for style
 * re-reads alone; transform additionally moves the client rects of its own
 * subtree; layout can move anybody's. Each rank subsumes the ones before
 * it, which is what lets a single class describe a whole animation.
 *
 * @type {Record<AnimationClass, number>}
 */
const CLASS_RANK = { paint: 0, transform: 1, layout: 2 };

const TRANSFORM_PROPERTIES = new Set([
  "transform",
  "transform-origin",
  "translate",
  "rotate",
  "scale",
  "offset-path",
  "offset-distance",
]);

const PAINT_PROPERTIES = new Set([
  "opacity",
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "box-shadow",
  "visibility",
  "filter",
]);

/**
 * The invalidation class of one animated property. Keyframes hand properties
 * back camelCased; transition events use the CSS names; both resolve here.
 * Anything unrecognized — including a missing name — is assumed to move
 * layout, the class that invalidates most.
 *
 * @param {string} [property]
 * @returns {AnimationClass}
 */
function classify(property) {
  if (!property) {
    return "layout";
  }
  const name = property.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
  if (TRANSFORM_PROPERTIES.has(name)) {
    return "transform";
  }
  if (PAINT_PROPERTIES.has(name)) {
    return "paint";
  }
  return "layout";
}

/**
 * The worst class across every property a keyframe effect animates.
 *
 * @param {AnimationEffect | null} effect
 * @returns {AnimationClass}
 */
function classifyKeyframes(effect) {
  if (
    typeof KeyframeEffect === "undefined" ||
    !(effect instanceof KeyframeEffect) ||
    typeof effect.getKeyframes !== "function"
  ) {
    return "layout";
  }
  /** @type {AnimationClass} */
  let worst = "paint";
  for (const frame of effect.getKeyframes()) {
    for (const property of Object.keys(frame)) {
      if (
        property === "offset" ||
        property === "computedOffset" ||
        property === "easing" ||
        property === "composite"
      ) {
        continue;
      }
      const cls = classify(property);
      if (CLASS_RANK[cls] > CLASS_RANK[worst]) {
        worst = cls;
      }
    }
  }
  return worst;
}

/**
 * How many ticks between `getAnimations()` reconciliations — about once a
 * second at typical frame rates.
 */
const SWEEP_INTERVAL = 60;

/**
 * @param {HTMLElement} container The portal's container element; animation
 *   events bubble to it, and membership is confined to its subtree.
 * @param {(batches: MutationBatch[]) => void} emit Receives the invalidation
 *   batches of one sample — once per frame while anything animates, plus a
 *   settling call when an animation ends.
 * @param {(tick: () => void) => () => void} requestFrames Starts calling
 *   `tick` once per frame; returns the way to stop. Only ever held while the
 *   membership is non-empty.
 */
export function createAnimationClock(container, emit, requestFrames) {
  /**
   * What is animating right now: for each element, its running animations —
   * keyed so that a transition's end event can find what its start event
   * added — each with the invalidation class of what it animates.
   *
   * @type {Map<HTMLElement, Map<string, AnimationClass>>}
   */
  const animating = new Map();

  /** @type {(() => void) | null} */
  let stopFrames = null;
  let ticks = 0;

  function start() {
    if (!stopFrames) {
      stopFrames = requestFrames(tick);
    }
  }

  function stop() {
    if (stopFrames) {
      stopFrames();
      stopFrames = null;
    }
  }

  /**
   * The batches one sample of the current membership asks for: a style
   * re-read scoped to the animating elements always; a rect re-measure of
   * their subtrees when transforms are moving them; a portal-wide re-measure
   * when something is animating layout, which moves elements nobody named.
   *
   * @returns {MutationBatch[]}
   */
  function buildBatches() {
    /** @type {Set<Node>} */
    const targets = new Set();
    /** @type {Set<Node>} */
    const transformTargets = new Set();
    let layout = false;
    for (const [element, keys] of animating) {
      targets.add(element);
      for (const cls of keys.values()) {
        if (cls === "layout") {
          layout = true;
        } else if (cls === "transform") {
          transformTargets.add(element);
        }
      }
    }
    /** @type {MutationBatch[]} */
    const batches = [{ types: new Set(["animated"]), targets }];
    if (layout) {
      batches.push({ types: new Set(["reflow"]), targets: null });
    } else if (transformTargets.size) {
      batches.push({ types: new Set(["reflow"]), targets: transformTargets });
    }
    return batches;
  }

  /**
   * One last sample for an animation that just finished: the property has
   * landed on its final value, and no further frame is coming to pick it up.
   *
   * @param {HTMLElement} element
   * @param {AnimationClass} cls
   */
  function settle(element, cls) {
    /** @type {MutationBatch[]} */
    const batches = [{ types: new Set(["animated"]), targets: new Set([element]) }];
    if (cls === "layout") {
      batches.push({ types: new Set(["reflow"]), targets: null });
    } else if (cls === "transform") {
      batches.push({ types: new Set(["reflow"]), targets: new Set([element]) });
    }
    emit(batches);
  }

  /**
   * @param {HTMLElement} element
   * @param {string} key
   * @param {AnimationClass} cls
   */
  function add(element, key, cls) {
    let keys = animating.get(element);
    if (!keys) {
      keys = new Map();
      animating.set(element, keys);
    }
    keys.set(key, cls);
    start();
  }

  /**
   * @param {HTMLElement} element
   * @param {string} key
   */
  function remove(element, key) {
    const keys = animating.get(element);
    const cls = keys?.get(key);
    if (!keys || cls === undefined) {
      return;
    }
    keys.delete(key);
    if (!keys.size) {
      animating.delete(element);
    }
    settle(element, cls);
    if (!animating.size) {
      stop();
    }
  }

  /**
   * Rebuild membership from what the platform says is actually running.
   * Authoritative where available: it adds the Web Animations that fired no
   * CSS event, refines the conservative guess `animationstart` had to make
   * (keyframes say which properties they animate; the event does not), and
   * clears anything whose end event got lost.
   */
  function sweep() {
    if (typeof container.getAnimations !== "function") {
      return;
    }
    /** @type {Map<HTMLElement, Map<string, AnimationClass>>} */
    const seen = new Map();
    for (const animation of container.getAnimations({ subtree: true })) {
      // A pending animation is about to run — a start the events may not
      // have announced yet.
      if (animation.playState !== "running" && !animation.pending) {
        continue;
      }
      const effect = animation.effect;
      const target =
        typeof KeyframeEffect !== "undefined" && effect instanceof KeyframeEffect
          ? effect.target
          : null;
      if (!(target instanceof HTMLElement) || !container.contains(target)) {
        continue;
      }
      let keys = seen.get(target);
      if (!keys) {
        keys = new Map();
        seen.set(target, keys);
      }
      if (typeof CSSTransition !== "undefined" && animation instanceof CSSTransition) {
        keys.set(
          `transition:${animation.transitionProperty}`,
          classify(animation.transitionProperty),
        );
      } else if (typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation) {
        keys.set(`animation:${animation.animationName}`, classifyKeyframes(effect));
      } else {
        keys.set("waapi", classifyKeyframes(effect));
      }
    }
    animating.clear();
    for (const [element, keys] of seen) {
      animating.set(element, keys);
    }
    if (animating.size) {
      start();
    } else {
      stop();
    }
  }

  function tick() {
    ticks += 1;
    // An element removed mid-flight fires no end event; the sweep would
    // catch it eventually, but a whole second of sampling a detached tree is
    // not worth saving one containment check per animating element.
    for (const element of [...animating.keys()]) {
      if (!container.contains(element)) {
        animating.delete(element);
      }
    }
    if (ticks % SWEEP_INTERVAL === 0) {
      sweep();
    }
    if (!animating.size) {
      stop();
      return;
    }
    emit(buildBatches());
  }

  /** @param {Event} event */
  function onTransitionAdd(event) {
    const element = event.target;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const { propertyName } = /** @type {TransitionEvent} */ (event);
    add(element, `transition:${propertyName}`, classify(propertyName));
  }

  /** @param {Event} event */
  function onTransitionRemove(event) {
    const element = event.target;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const { propertyName } = /** @type {TransitionEvent} */ (event);
    remove(element, `transition:${propertyName}`);
  }

  /** @param {Event} event */
  function onAnimationAdd(event) {
    const element = event.target;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const { animationName } = /** @type {AnimationEvent} */ (event);
    // The event does not say which properties the keyframes animate, so
    // assume the worst; the sweep refines it right away where it can.
    add(element, `animation:${animationName}`, "layout");
    sweep();
  }

  /** @param {Event} event */
  function onAnimationRemove(event) {
    const element = event.target;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const { animationName } = /** @type {AnimationEvent} */ (event);
    remove(element, `animation:${animationName}`);
  }

  // `transitionrun` fires on creation, `transitionstart` after the delay;
  // either may be the first one seen, and adding is idempotent.
  container.addEventListener("transitionrun", onTransitionAdd);
  container.addEventListener("transitionstart", onTransitionAdd);
  container.addEventListener("transitionend", onTransitionRemove);
  container.addEventListener("transitioncancel", onTransitionRemove);
  container.addEventListener("animationstart", onAnimationAdd);
  container.addEventListener("animationend", onAnimationRemove);
  container.addEventListener("animationcancel", onAnimationRemove);

  return {
    dispose() {
      container.removeEventListener("transitionrun", onTransitionAdd);
      container.removeEventListener("transitionstart", onTransitionAdd);
      container.removeEventListener("transitionend", onTransitionRemove);
      container.removeEventListener("transitioncancel", onTransitionRemove);
      container.removeEventListener("animationstart", onAnimationAdd);
      container.removeEventListener("animationend", onAnimationRemove);
      container.removeEventListener("animationcancel", onAnimationRemove);
      animating.clear();
      stop();
    },
  };
}
