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
 * downstream just works. A held clock emits nothing, and the portal holds
 * it while its panel loads. An empty set requests no frames: the idle cost
 * of all of this is nothing.
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

/**
 * Whether an event target or an animation's target is an element at all —
 * HTML or SVG alike. Not `instanceof HTMLElement`, which is what this used
 * to ask: an animating `<path>` is an `SVGElement`, and the clock left every
 * SVG animation unsampled. Not `instanceof Element` either, because the test
 * runner's jsdom setup installs `HTMLElement` and `Node` as globals and not
 * `Element`, and the node type says the same thing everywhere.
 *
 * @param {unknown} target
 * @returns {target is Element}
 */
function isElement(target) {
  return (
    typeof target === "object" &&
    target !== null &&
    /** @type {Node} */ (target).nodeType === Node.ELEMENT_NODE
  );
}

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
  // SVG's paint and geometry: none of these can move a CSS box, and the
  // shape that reads them redraws itself from its own computed style, so a
  // marching-ants `stroke-dashoffset` is a style re-read of one element per
  // frame rather than a re-measure of the panel. `x`, `y`, `width` and
  // `height` are not here — on an HTML element they are layout, and the
  // clock cannot tell from a property name which kind of element it is on.
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
]);

/**
 * The paint properties a child inherits. Everything else in the paint and
 * transform classes stays on the element it is set on — a rotating card does
 * not change a single computed value under it — which is what lets the clock
 * restyle the animating element alone rather than its subtree. The layout
 * class is never narrowed: `font-size`, `line-height` and their kind inherit,
 * and an unrecognized property is assumed to be one of them.
 *
 * "Stays on the element" is the default and not a law: a child that says
 * `background-color: inherit` takes its parent's background, animating or
 * not. See `reachesChildren` for how the clock finds out.
 */
const INHERITED_PAINT_PROPERTIES = new Set(["color", "visibility"]);

/**
 * How one animation is held: its invalidation class, whether what it
 * animates inherits by default, and — for what does not — which properties
 * those are, so that a child inheriting one of them explicitly can be
 * caught.
 *
 * @typedef {object} Animated
 * @property {AnimationClass} cls
 * @property {boolean} inherited
 * @property {string[]} properties the non-inherited ones, kebab-case
 */

/**
 * @param {string} name a CSS property name, camelCased or not
 * @returns {string}
 */
function kebab(name) {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
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
 * One animated property as the clock holds it. Anything the layout class
 * holds is taken to inherit, missing names included.
 *
 * @param {string} [property]
 * @returns {Animated}
 */
function animatedProperty(property) {
  const cls = classify(property);
  if (cls === "layout" || !property) {
    return { cls, inherited: true, properties: [] };
  }
  const name = kebab(property);
  return INHERITED_PAINT_PROPERTIES.has(name)
    ? { cls, inherited: true, properties: [] }
    : { cls, inherited: false, properties: [name] };
}

/**
 * Everything some animations amount to: the worst class among them, whether
 * any inherits, and every non-inherited property they animate. The one fold
 * both an element's running animations and a keyframe effect's properties
 * go through.
 *
 * @param {Iterable<Animated>} animations
 * @returns {Animated}
 */
function combine(animations) {
  /** @type {AnimationClass} */
  let cls = "paint";
  let inherited = false;
  /** @type {Set<string>} */
  const properties = new Set();
  for (const animation of animations) {
    if (CLASS_RANK[animation.cls] > CLASS_RANK[cls]) {
      cls = animation.cls;
    }
    if (animation.inherited) {
      inherited = true;
    }
    for (const property of animation.properties) {
      properties.add(property);
    }
  }
  return { cls, inherited, properties: [...properties] };
}

/**
 * What a keyframe effect animates, folded over every property its keyframes
 * name.
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
    return { cls: "layout", inherited: true, properties: [] };
  }
  /** @type {Animated[]} */
  const animated = [];
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
      animated.push(animatedProperty(property));
    }
  }
  return combine(animated);
}

/**
 * Whether a child of `element` takes one of these properties from it — an
 * explicit `inherit` on something that does not inherit by default, which
 * the restyle of the element alone would never reach.
 *
 * Only children, never deeper: a grandchild inheriting explicitly inherits
 * from its parent, whose value moves only if that parent inherits too — in
 * which case the parent is the child found here, and the subtree restyle it
 * causes reaches the grandchild. And by value, because a computed style
 * does not say *why* it holds what it holds: a child that inherits holds
 * exactly its parent's value, on every frame. A child that happens to hold
 * the same value without inheriting it costs a subtree restyle it did not
 * need, which is the safe way to be wrong.
 *
 * @param {Element} element
 * @param {string[]} properties kebab-case
 * @returns {boolean}
 */
function reachesChildren(element, properties) {
  const view = element.ownerDocument.defaultView;
  if (!view || !element.firstElementChild) {
    return !view;
  }
  const own = view.getComputedStyle(element);
  const values = properties.map((property) => own.getPropertyValue(property));
  for (const child of element.children) {
    const theirs = view.getComputedStyle(child);
    for (let index = 0; index < properties.length; index++) {
      if (theirs.getPropertyValue(properties[index]) === values[index]) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether one element's animations, taken together, can move a descendant's
 * computed style — by default inheritance, or by a child's explicit
 * `inherit`.
 *
 * @param {Element} element
 * @param {Animated} animated
 * @returns {boolean}
 */
function reachesSubtree(element, animated) {
  return animated.inherited || reachesChildren(element, animated.properties);
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
 * @param {object} [options]
 * @param {() => boolean} [options.held] Asked every frame: while it answers
 *   true, the frame's sample is not emitted. The portal holds the clock
 *   while its panel loads, since nobody sees the panel yet and the mount
 *   reads each style as it builds it; a sample per frame would only undo
 *   what the mount had read, and under an endless animation the mount would
 *   never finish. Where the clock drives the animations itself, with the
 *   page's rendering suspended, a held frame drives nothing, writing no
 *   `currentTime`, and still looks for what started and what ended. The
 *   first frame after the hold advances them by the whole of it, or, for one
 *   that started during it, by the time since it started. Elsewhere
 *   membership is kept up all the while. Either way the first frame after
 *   the hold names every element still animating, and an animation that ends
 *   is still settled, since an end is said once and not every frame.
 */
export function createAnimationClock(container, emit, requestFrames, { held = () => false } = {}) {
  /**
   * What is animating right now: for each element, its running animations —
   * keyed so that a transition's end event can find what its start event
   * added — each with the invalidation class of what it animates and
   * whether that inherits.
   *
   * @type {Map<Element, Map<string, Animated>>}
   */
  const animating = new Map();

  /**
   * Elements whose children have been seen *not* to take what they animate
   * — see `reachesChildren` — for as long as the same animations run.
   *
   * A child that inherits explicitly holds its parent's value on every
   * frame, so a single frame on which no child matches proves none of them
   * inherits, and the reads need not be repeated. The frames before it are
   * not proof either way: a card turning from `none` matches its children's
   * `none` until it has moved, which is why the verdict waits for a
   * mismatch instead of being taken when the animation starts. Forgotten
   * whenever the element's set of animations changes, since what is
   * compared changes with it. A row appended mid-animation that inherits
   * is missed until the settle, which checks afresh.
   *
   * @type {WeakSet<Element>}
   */
  const narrow = new WeakSet();

  /**
   * `reachesSubtree`, for a running animation: remembers the element once a
   * frame has shown that no child inherits.
   *
   * @param {Element} element
   * @param {Animated} animated
   * @returns {boolean}
   */
  function reachesSubtreeWhileRunning(element, animated) {
    if (animated.inherited) {
      return true;
    }
    if (narrow.has(element)) {
      return false;
    }
    if (reachesChildren(element, animated.properties)) {
      return true;
    }
    narrow.add(element);
    return false;
  }

  /**
   * Whether two sets of running animations are the same ones.
   *
   * @param {Map<string, Animated> | undefined} a
   * @param {Map<string, Animated>} b
   * @returns {boolean}
   */
  function sameAnimations(a, b) {
    if (!a || a.size !== b.size) {
      return false;
    }
    for (const key of b.keys()) {
      if (!a.has(key)) {
        return false;
      }
    }
    return true;
  }

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
  /**
   * When each animation that started during a hold, with the clock driving,
   * was first seen. The hold keeps one account from when driving started,
   * and an animation that started later is owed only the time since; the
   * first driven frame after the hold reads this and clears it. Keyed by
   * the animation and not its element, since an element already animating
   * can start another.
   *
   * @type {Map<Animation, number>}
   */
  const joinedDuringHold = new Map();

  /**
   * The animations the last sweep saw, kept to tell one that has just
   * started from one that was running already. One set, refilled by each
   * sweep, rather than one per sweep.
   *
   * @type {Set<Animation>}
   */
  const lastSeen = new Set();

  /**
   * Keep `animations` as the ones the last look saw.
   *
   * @param {Animation[]} animations
   */
  function remember(animations) {
    lastSeen.clear();
    for (const animation of animations) {
      lastSeen.add(animation);
    }
  }

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
    // Nothing animates, so nothing is owed: the next animation is driven
    // from its own start, not by everything since this account was opened.
    lastDrivenAt = null;
    lastDocumentTime = null;
    joinedDuringHold.clear();
    lastSeen.clear();
  }

  /**
   * The batches one sample asks for: a style re-read of the animating
   * elements always — of their subtrees where what animates can reach a
   * child, of the elements alone where it cannot; a portal-wide rect
   * re-measure when layout itself is animating, which moves elements nobody
   * named; a subtree rect re-measure when a *transform* settles — and only
   * then. While a transform animates,
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
      const animated = combine(keys.values());
      const { cls } = animated;
      (reachesSubtreeWhileRunning(element, animated) ? targets : selfTargets).add(element);
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
   * @param {Element} element
   * @param {Animated} animated
   */
  function settle(element, animated) {
    const { cls } = animated;
    const target = new Set([element]);
    const none = new Set();
    // Checked again rather than trusted from the last frame: the value the
    // property lands on is what a child that inherits it has to show.
    const subtree = reachesSubtree(element, animated);
    emit(
      batchesFor(
        subtree ? target : none,
        subtree ? none : target,
        cls === "transform" ? target : none,
        cls === "layout",
      ),
    );
  }

  /**
   * @param {Element} element
   * @param {string} key
   * @param {Animated} animated
   */
  function add(element, key, animated) {
    let keys = animating.get(element);
    if (!keys) {
      keys = new Map();
      animating.set(element, keys);
    }
    if (!keys.has(key)) {
      narrow.delete(element);
    }
    keys.set(key, animated);
    start();
  }

  /**
   * @param {Element} element
   * @param {string} key
   */
  function remove(element, key) {
    const keys = animating.get(element);
    const animated = keys?.get(key);
    if (!keys || animated === undefined) {
      return;
    }
    keys.delete(key);
    narrow.delete(element);
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
   * Called with nothing, it only looks. Called to drive, it takes all three
   * of what follows, or the types refuse it: without `now`, an animation
   * that started during a hold would be owed a negative time and never
   * moved. Three numbers rather than one object, since the driving branch
   * calls this every frame.
   *
   * @overload
   * @returns {void}
   */
  /**
   * @overload
   * @param {number} advanceBy Milliseconds of real time to move every running
   *   animation on by first. Nonzero only while the document is suspended,
   *   where the rendering step that would ordinarily do this has stopped.
   * @param {number} browserAdvance How much of that the document's own
   *   timeline covered — what the browser has already carried its
   *   animations through, and so must not be charged for twice.
   * @param {number} now The `performance.now()` the elapsed time was
   *   measured against: an animation that started during a hold is owed
   *   only the share of the interval since it was first seen.
   * @returns {void}
   */
  /**
   * @param {number} [advanceBy]
   * @param {number} [browserAdvance]
   * @param {number} [now]
   */
  function sweep(advanceBy = 0, browserAdvance = 0, now = 0) {
    if (typeof container.getAnimations !== "function") {
      return;
    }
    const animations = container.getAnimations({ subtree: true });
    // What started since the last sweep, while held with the clock driving,
    // is owed only the time since now. No animation event is dispatched
    // while the clock drives, so a sweep is the only way one is learned.
    if (lastDrivenAt !== null && held()) {
      const seenAt = performance.now();
      for (const animation of animations) {
        if (!lastSeen.has(animation)) {
          joinedDuringHold.set(animation, seenAt);
        }
      }
    }
    remember(animations);
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
        // One that started during a hold is owed only its share of the
        // interval: what the timeline covered of the time since it joined is
        // in the same proportion as what it covered of the whole.
        const joined = joinedDuringHold.get(animation);
        const owed = anchored ? shortfall : advanceBy;
        const delta = joined === undefined ? owed : (owed * (now - joined)) / advanceBy;
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
      joinedDuringHold.clear();
    }
    /** @type {Map<Element, Map<string, Animated>>} */
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
      if (!isElement(target) || !container.contains(target)) {
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
    /** @type {[Element, Animated][]} */
    const finished = [];
    for (const [element, keys] of animating) {
      if (seen.has(element)) {
        continue;
      }
      finished.push([element, combine(keys.values())]);
    }
    for (const [element, keys] of seen) {
      if (!sameAnimations(animating.get(element), keys)) {
        narrow.delete(element);
      }
    }
    for (const [element] of finished) {
      narrow.delete(element);
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
        narrow.delete(element);
        for (const animation of joinedDuringHold.keys()) {
          if (/** @type {KeyframeEffect | null} */ (animation.effect)?.target === element) {
            joinedDuringHold.delete(animation);
          }
        }
      }
    }
    if (sampleRenderingUpdates()) {
      if (held()) {
        // Nothing driven: each `currentTime` write dirties a style the mount
        // would read again. The account keeps running from when driving
        // started, so the first frame after the hold advances by all of it.
        // Each held frame still looks, as a driven frame does, since no event
        // says an animation started or ended while the clock drives: a look
        // reads and writes nothing, notes what started within a frame of its
        // start, and finds what has ended, so that an empty membership holds
        // no frames here either.
        recheck = false;
        sweep();
        if (!animating.size) {
          stop();
          return;
        }
        if (lastDrivenAt === null) {
          // What the sweep above saw runs now and is owed the whole hold;
          // only what a later sweep finds that it did not see started
          // during it.
          lastDrivenAt = performance.now();
          lastDocumentTime = documentTime();
        }
        return;
      }
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
      sweep(elapsed, browserAdvance, now);
    } else {
      // The browser is driving; the events keep membership honest and the
      // sweep is only there to catch what they miss.
      lastDrivenAt = null;
      lastDocumentTime = null;
      joinedDuringHold.clear();
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
    if (held()) {
      return;
    }
    emit(buildBatches());
  }

  /** @param {Event} event */
  function onTransitionAdd(event) {
    const element = event.target;
    if (!isElement(element)) {
      return;
    }
    const { propertyName } = /** @type {TransitionEvent} */ (event);
    add(element, `transition:${propertyName}`, animatedProperty(propertyName));
  }

  /** @param {Event} event */
  function onTransitionRemove(event) {
    const element = event.target;
    if (!isElement(element)) {
      return;
    }
    const { propertyName } = /** @type {TransitionEvent} */ (event);
    remove(element, `transition:${propertyName}`);
  }

  /** @param {Event} event */
  function onAnimationAdd(event) {
    const element = event.target;
    if (!isElement(element)) {
      return;
    }
    const { animationName } = /** @type {AnimationEvent} */ (event);
    // The event does not say which properties the keyframes animate, so
    // assume the worst; the sweep refines it right away where it can.
    add(element, `animation:${animationName}`, {
      cls: "layout",
      inherited: true,
      properties: [],
    });
    sweep();
  }

  /** @param {Event} event */
  function onAnimationRemove(event) {
    const element = event.target;
    if (!isElement(element)) {
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
