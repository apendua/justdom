import { documentTime, sampleRenderingUpdates } from "./renderingUpdates.js";

/**
 * The kinds of change the clock can announce, and the shape it announces
 * them in. `animated` says the computed styles of the targets' subtrees may
 * have moved; `animatedSelf` says only the targets' own have, because what
 * is animating does not inherit; `reflow` says client rects have — of the
 * targets' subtrees, or of everything when layout itself is animating and
 * no target can name what it displaced. The portal translates these into
 * the mirror's targeted invalidations.
 *
 * @typedef {"animated" | "animatedSelf" | "reflow"} MutationType
 */

/**
 * One announcement from the clock: which kinds of change happened, and the
 * nodes they happened at. `null` targets mean the whole portal is affected.
 *
 * @typedef {object} MutationBatch
 * @property {Set<MutationType>} types
 * @property {Set<Node> | null} targets
 */

/**
 * How an animated property ranks for invalidation — this file is organized
 * around it. Paint asks for style re-reads alone, transform adds a targeted
 * reflow, layout a portal-wide one.
 *
 * @typedef {"paint" | "transform" | "layout"} AnimationClass
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
 * The paint properties a child inherits. Everything else in the paint and
 * transform classes stays on the element it is set on — a rotating card does
 * not change a single computed value under it — which is what lets the clock
 * restyle the animating element alone rather than its subtree. The layout
 * class is never narrowed: `font-size`, `line-height` and their kind inherit,
 * and an unrecognized property is assumed to be one of them.
 */
const INHERITED_PAINT_PROPERTIES = new Set(["color", "visibility"]);

/**
 * How one animation is held: its invalidation class, and whether what it
 * animates can reach the element's descendants through inheritance.
 *
 * @typedef {object} Animated
 * @property {AnimationClass} cls
 * @property {boolean} inherited
 */

/**
 * @param {string} name a CSS property name, kebab-case
 * @returns {string}
 */
function kebab(name) {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/**
 * Whether an animated property can change a descendant's computed style.
 * Anything the layout class holds is assumed to, missing names included.
 *
 * @param {string} [property]
 * @returns {boolean}
 */
function inherits(property) {
  const cls = classify(property);
  return (
    cls === "layout" || INHERITED_PAINT_PROPERTIES.has(kebab(/** @type {string} */ (property)))
  );
}

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
  const name = kebab(property);
  if (TRANSFORM_PROPERTIES.has(name)) {
    return "transform";
  }
  if (PAINT_PROPERTIES.has(name)) {
    return "paint";
  }
  return "layout";
}

/**
 * One animated property as the clock holds it.
 *
 * @param {string} [property]
 * @returns {Animated}
 */
function animatedProperty(property) {
  return { cls: classify(property), inherited: inherits(property) };
}

/**
 * The worst class across every property a keyframe effect animates, and
 * whether any of them inherits.
 *
 * @param {AnimationEffect | null} effect
 * @returns {Animated}
 */
function classifyKeyframes(effect) {
  // Duck-typed rather than `instanceof KeyframeEffect`: only that subclass
  // has keyframes to read, and asking whether it can be read is both the
  // same question and one that survives a document without the constructor.
  const keyframed = /** @type {KeyframeEffect | null} */ (effect);
  if (!keyframed || typeof keyframed.getKeyframes !== "function") {
    return { cls: "layout", inherited: true };
  }
  /** @type {AnimationClass} */
  let worst = "paint";
  let inherited = false;
  for (const frame of keyframed.getKeyframes()) {
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
      if (inherits(property)) {
        inherited = true;
      }
    }
  }
  return { cls: worst, inherited };
}

/**
 * Everything one element's running animations amount to: the worst class
 * among them, and whether any reaches the subtree.
 *
 * @param {Iterable<Animated>} animations
 * @returns {Animated}
 */
function combine(animations) {
  /** @type {AnimationClass} */
  let cls = "paint";
  let inherited = false;
  for (const animation of animations) {
    if (CLASS_RANK[animation.cls] > CLASS_RANK[cls]) {
      cls = animation.cls;
    }
    if (animation.inherited) {
      inherited = true;
    }
  }
  return { cls, inherited };
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
   * added — each with the invalidation class of what it animates and
   * whether that inherits.
   *
   * @type {Map<HTMLElement, Map<string, Animated>>}
   */
  const animating = new Map();

  /** @type {(() => void) | null} */
  let stopFrames = null;
  let ticks = 0;
  /**
   * When the animations were last moved on by hand, in real time. Null
   * whenever the browser is doing it, so the first frame after it stops
   * advances by nothing rather than by however long the browser had it.
   *
   * @type {number | null}
   */
  let lastDrivenAt = null;
  /**
   * The document time read at that same moment, so the next reading can say
   * how much of the elapsed time the browser's own timeline covered. Null
   * alongside `lastDrivenAt`, and for the same reason.
   *
   * @type {number | null}
   */
  let lastDocumentTime = null;
  /**
   * Whether the next tick should sweep whether or not one is otherwise due.
   * Set by a mutation that started nothing the platform would admit to yet;
   * see the exported `sweep` below.
   */
  let recheck = false;

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
   * The batches one sample asks for: a style re-read of the animating
   * elements always — of their subtrees where what animates inherits, of
   * the elements alone where it does not; a portal-wide rect re-measure when layout itself is
   * animating, which moves elements nobody named; a subtree rect re-measure
   * when a *transform* settles — and only then. While a transform animates,
   * nothing consumes its client rects (elements measure off layout offsets,
   * text measures with transforms switched off), so per-frame reflow would
   * buy nothing and cost a text re-measure per tick. The moment the
   * transform stops is different: the element returns to the subpixel
   * client-rect path, and the rects its subtree cached mid-flight are
   * whatever the animation last made of them.
   *
   * @param {Set<Node>} targets restyled with their subtrees
   * @param {Set<Node>} selfTargets restyled alone
   * @param {Set<Node>} transformTargets
   * @param {boolean} layout
   * @returns {MutationBatch[]}
   */
  function batchesFor(targets, selfTargets, transformTargets, layout) {
    /** @type {MutationBatch[]} */
    const batches = [];
    if (targets.size) {
      batches.push({ types: new Set(["animated"]), targets });
    }
    if (selfTargets.size) {
      batches.push({ types: new Set(["animatedSelf"]), targets: selfTargets });
    }
    if (layout) {
      batches.push({ types: new Set(["reflow"]), targets: null });
    } else if (transformTargets.size) {
      batches.push({ types: new Set(["reflow"]), targets: transformTargets });
    }
    return batches;
  }

  /** @returns {MutationBatch[]} */
  function buildBatches() {
    /** @type {Set<Node>} */
    const targets = new Set();
    /** @type {Set<Node>} */
    const selfTargets = new Set();
    let layout = false;
    for (const [element, keys] of animating) {
      const { cls, inherited } = combine(keys.values());
      (inherited ? targets : selfTargets).add(element);
      if (cls === "layout") {
        layout = true;
      }
    }
    return batchesFor(targets, selfTargets, new Set(), layout);
  }

  /**
   * One last sample for an animation that just finished: the property has
   * landed on its final value, and no further frame is coming to pick it up.
   *
   * @param {HTMLElement} element
   * @param {Animated} animated
   */
  function settle(element, { cls, inherited }) {
    const target = new Set([element]);
    const none = new Set();
    emit(
      batchesFor(
        inherited ? target : none,
        inherited ? none : target,
        cls === "transform" ? target : none,
        cls === "layout",
      ),
    );
  }

  /**
   * @param {HTMLElement} element
   * @param {string} key
   * @param {Animated} animated
   */
  function add(element, key, animated) {
    let keys = animating.get(element);
    if (!keys) {
      keys = new Map();
      animating.set(element, keys);
    }
    keys.set(key, animated);
    start();
  }

  /**
   * @param {HTMLElement} element
   * @param {string} key
   */
  function remove(element, key) {
    const keys = animating.get(element);
    const animated = keys?.get(key);
    if (!keys || animated === undefined) {
      return;
    }
    keys.delete(key);
    if (!keys.size) {
      animating.delete(element);
    }
    settle(element, animated);
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
   *
   * It is also the *only* way membership is learned while the document is
   * not being rendered, where no animation event is ever dispatched — which
   * is why the portal calls it on every mutation, the one signal that still
   * arrives (observer callbacks are microtasks, owing nothing to frames).
   *
   * @param {number} [advanceBy] Milliseconds of real time to move every
   *   running animation on by first. Nonzero only while the document is
   *   suspended, where the rendering step that would ordinarily do this has
   *   stopped.
   * @param {number} [browserAdvance] How much of that the document's own
   *   timeline covered — what the browser has already carried its animations
   *   through, and so must not be charged for twice.
   */
  function sweep(advanceBy = 0, browserAdvance = 0) {
    if (typeof container.getAnimations !== "function") {
      return;
    }
    const animations = container.getAnimations({ subtree: true });
    if (advanceBy > 0) {
      // What is left for us to do. A timeline that has stopped with the
      // frames leaves the whole of it; one that keeps running while the page
      // is not being drawn — which some browsers do, and which is not a thing
      // to infer from the page having stopped being rendered — has already
      // moved every animation it holds, and adding to that would play them at
      // double speed. Anything in between, a page rendering at a fraction of
      // the session's rate, is topped up by exactly its shortfall.
      const shortfall = Math.max(0, advanceBy - browserAdvance);
      for (const animation of animations) {
        if (animation.playState !== "running") {
          continue;
        }
        // An animation with no start time is not being carried by the
        // timeline at all, however briskly that timeline is running: what
        // would have given it one is the pending play task, which belongs to
        // the same rendering step everything else here is missing. That is
        // every animation *started* inside a session — the meter that moves
        // on a click, the button that lights under the ray — as against the
        // ones that were already running when the headset went on, which
        // have their start time and are moving if anything is. It is also
        // why a panel can look dead while the panel beside it looks alive.
        const anchored = typeof animation.startTime === "number";
        const delta = anchored ? shortfall : advanceBy;
        if (delta <= 0) {
          continue;
        }
        const current = animation.currentTime;
        if (typeof current === "number") {
          // Writing `currentTime` re-anchors the animation against its
          // stalled timeline, and the style recalc that any subsequent read
          // forces applies the value that lands on. The classification below
          // re-reads `playState`, so anything this pushes past its end is
          // retired in the same pass.
          animation.currentTime = current + delta;
        } else if (!anchored) {
          // Neither a start time nor a hold time: nothing has been in a
          // position to give it a place on the timeline. Start it where the
          // rendering step would have.
          animation.currentTime = delta;
        }
      }
    }
    /** @type {Map<HTMLElement, Map<string, Animated>>} */
    const seen = new Map();
    for (const animation of animations) {
      // A pending animation is about to run — a start the events may not
      // have announced yet.
      if (animation.playState !== "running" && !animation.pending) {
        continue;
      }
      const effect = animation.effect;
      // Same duck-typing as above: what matters is that the effect names an
      // element, not which constructor it came from.
      const target = effect ? /** @type {KeyframeEffect} */ (effect).target : null;
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
          animatedProperty(animation.transitionProperty),
        );
      } else if (typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation) {
        keys.set(`animation:${animation.animationName}`, classifyKeyframes(effect));
      } else {
        keys.set("waapi", classifyKeyframes(effect));
      }
    }
    // Anything that was running and no longer is has just landed on its final
    // value, and — with no `transitionend` to rely on, which is the whole
    // point of sweeping — this pass is the only notice of it.
    /** @type {[HTMLElement, Animated][]} */
    const finished = [];
    for (const [element, keys] of animating) {
      if (seen.has(element)) {
        continue;
      }
      finished.push([element, combine(keys.values())]);
    }
    animating.clear();
    for (const [element, keys] of seen) {
      animating.set(element, keys);
    }
    for (const [element, animated] of finished) {
      settle(element, animated);
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
    if (sampleRenderingUpdates()) {
      // No event will say when an animation starts or stops, so every frame
      // is a sweep: make up whatever of the elapsed time the document's own
      // timeline did not cover, then read back what is still running.
      const now = performance.now();
      const documentNow = documentTime();
      const elapsed = lastDrivenAt === null ? 0 : now - lastDrivenAt;
      const browserAdvance =
        lastDrivenAt === null || lastDocumentTime === null || documentNow === null
          ? 0
          : Math.max(0, documentNow - lastDocumentTime);
      lastDrivenAt = now;
      lastDocumentTime = documentNow;
      recheck = false;
      sweep(elapsed, browserAdvance);
    } else {
      // The browser is driving; the events keep membership honest and the
      // sweep is only there to catch what they miss.
      lastDrivenAt = null;
      lastDocumentTime = null;
      const wanted = recheck;
      recheck = false;
      if (wanted || ticks % SWEEP_INTERVAL === 0) {
        sweep();
      }
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
    add(element, `transition:${propertyName}`, animatedProperty(propertyName));
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
    add(element, `animation:${animationName}`, { cls: "layout", inherited: true });
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
    /**
     * Look for animations the events cannot report. The portal calls this on
     * every mutation batch: a class swap is what starts most transitions, and
     * while the document is suspended the mutation is the only trace of it
     * that reaches us.
     */
    sweep() {
      sweep();
      if (!animating.size) {
        // Nothing is animating *yet*. A transition begins with the style
        // change this mutation carried, and whether the browser has created
        // it by the time a microtask asks `getAnimations()` is a question of
        // when the style recalc lands — which, in a document nobody is
        // rendering, is not a question with a settled answer. With no event
        // coming to announce it and no other sweep due, one missed here
        // would be missed for good, so take one more look next frame. It
        // costs a single frame of a loop that is otherwise not running.
        recheck = true;
        start();
      }
    },
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
