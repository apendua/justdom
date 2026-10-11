import * as THREE from "three";
import { withComputation } from "@apendua/signal";
import { getBorderBoxSize } from "./mirror.js";
import { emptyTally, setProbing, takeTallies, unprobed } from "./outlineProbe.js";
import { describeElement } from "./panelFrame.js";
import { isSvgElement, isSvgRoot, readBBox } from "./plugins.js";

/**
 * @import {Tally} from './outlineProbe.js';
 */

/**
 * Outlines mode: a developer's view of how often each element of a panel
 * changes, drawn over the panel as a rectangle round the element.
 *
 * What is counted is in `outlineProbe.js`. What is drawn is decided per
 * element at each commit of its panel, from what was counted since the one
 * before:
 *
 *   - A solid line, changed: the page changed the element.
 *   - A dashed line, a ripple: the page did not touch the element, and a
 *     read the mirror keeps for it came out different all the same. A row
 *     moved by the row above it growing, or a label that inherits a colour
 *     its card changed.
 *   - A dotted line, wasted: the page did not touch the element, the
 *     mirror read it again, and every read came out as it was. The mirror
 *     was told the element may have changed and it had not, which is where a
 *     gap in the mirror's filtering shows.
 *   - A grey line, a no-op write: the page wrote to the element what was
 *     already there, and the mirror dropped the write. It cost the panel
 *     nothing past the observer, and it is still the page doing work every
 *     time for nothing.
 *
 * The colour of the first three says how often: blue for about once a
 * second or less, then green, yellow, and red for ten times a second or
 * more. The rate counts commits the element was part of, not records: on an
 * atomic panel a commit is what the player sees.
 *
 * The outlines are taken at the commit and never before it. An atomic panel
 * shows the page as it was at its last commit, so a count taken when the
 * page changed would draw a box round something the panel does not show
 * yet. A panel whose commit had to be forced (`MAX_COMMIT_WAIT` or
 * `MAX_BUILD_WAIT` in `portalPump.js`) flashes a magenta line round its
 * whole edge: something in it changes on every frame, and the panel lands
 * once a second instead of following it.
 */

/** How long, in milliseconds, an outline takes to fade after a commit. */
const FADE = 1000;

/**
 * The time constant, in milliseconds, of the rate an outline is coloured by.
 */
const RATE_WINDOW = 1000;

/** How many outlines one panel draws at most in each style. */
const CAPACITY = 512;

/** Vertices per outline: four edges, two ends each. */
const VERTICES = 8;

/** How far, in the panel's px, the forced-commit line stands off the edge. */
const FORCED_MARGIN = 2;

/** @typedef {"changed" | "ripple" | "wasted" | "noop"} OutlineKind */

/**
 * What one element's outline is drawn from, kept from commit to commit.
 *
 * @typedef {object} OutlineEntry
 * @property {OutlineKind} kind How the last commit that counted it saw it.
 * @property {number} rate Commits it was part of, decayed over `RATE_WINDOW`:
 *   about how many it was part of in the last second.
 * @property {number} at When that commit was, by `performance.now()`.
 * @property {number} x Its outline at that commit, in its object's own
 *   space (`outlineBox`).
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {Tally} total Everything counted for it since outlines mode was
 *   turned on.
 * @property {number} commits How many commits drew it in that time.
 */

/**
 * The colours, from rare to frequent, and the rates each starts at.
 */
const RAMP = [
  { from: 0, color: new THREE.Color(0x3b82f6) },
  { from: 2, color: new THREE.Color(0x22c55e) },
  { from: 5, color: new THREE.Color(0xeab308) },
  { from: 10, color: new THREE.Color(0xef4444) },
];
const NOOP_COLOR = new THREE.Color(0x9ca3af);
const FORCED_COLOR = new THREE.Color(0xd946ef);

/**
 * The colour of an outline at `rate`.
 *
 * @param {number} rate
 * @returns {THREE.Color}
 */
export function rampColor(rate) {
  let color = RAMP[0].color;
  for (const step of RAMP) {
    if (rate >= step.from) {
      color = step.color;
    }
  }
  return color;
}

/**
 * How a commit saw an element, from what was counted for it since the last
 * one; null when nothing was worth drawing, as when the layout walk told it
 * it may have moved and nothing read it again.
 *
 * @param {Tally} tally
 * @returns {OutlineKind | null}
 */
export function classify(tally) {
  if (tally.changes > 0) {
    return "changed";
  }
  if (tally.recalculated > tally.unchanged) {
    return "ripple";
  }
  if (tally.recalculated > 0) {
    return "wasted";
  }
  if (tally.noopWrites > 0) {
    return "noop";
  }
  return null;
}

/**
 * One style of line: a pool of `CAPACITY` rectangles, rewritten in place.
 *
 * @param {THREE.LineBasicMaterial} material
 */
function createLines(material) {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(CAPACITY * VERTICES * 3), 3);
  const colors = new THREE.BufferAttribute(new Float32Array(CAPACITY * VERTICES * 4), 4);
  const distances = new THREE.BufferAttribute(new Float32Array(CAPACITY * VERTICES), 1);
  positions.setUsage(THREE.DynamicDrawUsage);
  colors.setUsage(THREE.DynamicDrawUsage);
  distances.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positions);
  geometry.setAttribute("color", colors);
  geometry.setAttribute("lineDistance", distances);
  geometry.setDrawRange(0, 0);
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = Number.MAX_SAFE_INTEGER;
  lines.matrixAutoUpdate = false;
  lines.raycast = () => {};
  let count = 0;
  return {
    lines,
    begin() {
      count = 0;
    },
    /**
     * @param {THREE.Matrix4} matrix From the rectangle's own space to the
     *   panel container's.
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {THREE.Color} color
     * @param {number} alpha
     */
    push(matrix, x, y, width, height, color, alpha) {
      if (count >= CAPACITY) {
        return;
      }
      const base = count * VERTICES;
      corner.set(x, y, 0).applyMatrix4(matrix);
      const ax = corner.x;
      const ay = corner.y;
      const az = corner.z;
      corner.set(x + width, y, 0).applyMatrix4(matrix);
      const bx = corner.x;
      const by = corner.y;
      const bz = corner.z;
      corner.set(x + width, y + height, 0).applyMatrix4(matrix);
      const cx = corner.x;
      const cy = corner.y;
      const cz = corner.z;
      corner.set(x, y + height, 0).applyMatrix4(matrix);
      const dx = corner.x;
      const dy = corner.y;
      const dz = corner.z;
      // A-B, B-C, C-D, D-A, each edge's dashes starting at its own corner.
      setVertex(base + 0, ax, ay, az, 0);
      setVertex(base + 1, bx, by, bz, Math.hypot(bx - ax, by - ay));
      setVertex(base + 2, bx, by, bz, 0);
      setVertex(base + 3, cx, cy, cz, Math.hypot(cx - bx, cy - by));
      setVertex(base + 4, cx, cy, cz, 0);
      setVertex(base + 5, dx, dy, dz, Math.hypot(dx - cx, dy - cy));
      setVertex(base + 6, dx, dy, dz, 0);
      setVertex(base + 7, ax, ay, az, Math.hypot(ax - dx, ay - dy));
      for (let i = base; i < base + VERTICES; i++) {
        colors.setXYZW(i, color.r, color.g, color.b, alpha);
      }
      count += 1;
    },
    end() {
      geometry.setDrawRange(0, count * VERTICES);
      positions.needsUpdate = true;
      colors.needsUpdate = true;
      distances.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };

  /**
   * @param {number} i
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} distance
   */
  function setVertex(i, x, y, z, distance) {
    positions.setXYZ(i, x, y, z);
    distances.setX(i, distance);
  }
}

/** Scratch for one corner on its way into the container's space. */
const corner = new THREE.Vector3();

/** Scratch for an element's object's matrix in the container's space. */
const toContainer = new THREE.Matrix4();

/**
 * Drawn over everything, the panel included, in the colour of each vertex.
 *
 * @returns {THREE.LineBasicMaterialParameters}
 */
function overlayMaterial() {
  return { vertexColors: true, transparent: true, depthTest: false, depthWrite: false };
}

/**
 * Where an element's outline goes, in the space of the object the panel
 * built for it, or null when there is no telling.
 *
 * A box, the `<svg>` root among them, has its object at its border-box
 * corner, in px, so its outline is its border box from there. Below the
 * root, an SVG element's object is in the element's own user space: the
 * root's content group carries the `viewBox`, and each element its own
 * transform (`svgNode` in `svg/shape.js`). Its outline is its `getBBox`,
 * which is in that same space, and which nothing else measured where its
 * object is. Both reads may force a layout: an SVG element's box is not
 * cached, and nor is the size of a box nothing in the panel reads. That is
 * one read per outline per commit, paid only while the mode is on.
 *
 * @param {Element} element
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function outlineBox(element) {
  if (isSvgElement(element) && !isSvgRoot(element)) {
    const bbox = readBBox(element);
    return bbox && { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
  }
  const size = getBorderBoxSize(/** @type {HTMLElement} */ (element));
  return { x: 0, y: 0, width: size.width, height: size.height };
}

/**
 * The matrix from `object`'s own space to `container`'s, into `out`, or
 * null when the object is not shown under the container: detached, or
 * under something hidden.
 *
 * @param {THREE.Object3D} object
 * @param {THREE.Object3D} container
 * @param {THREE.Matrix4} out
 * @returns {THREE.Matrix4 | null}
 */
function matrixWithin(object, container, out) {
  out.identity();
  /** @type {THREE.Object3D | null} */
  let current = object;
  while (current && current !== container) {
    if (!current.visible) {
      return null;
    }
    out.premultiply(current.matrix);
    current = current.parent;
  }
  return current === container ? out : null;
}

/**
 * @typedef {object} OutlineHostOptions
 * @property {Element} containerElement The panel's container element:
 *   whatever it contains is the panel's to draw.
 * @property {THREE.Object3D} containerObject What the panel's objects hang
 *   from, in the panel's px.
 * @property {(node: Node) => THREE.Object3D | undefined} objectOf The
 *   object the panel built for a node.
 * @property {(tick: () => void) => () => void} requestFrames
 */

/**
 * @typedef {object} OutlineHost
 * @property {() => void} commit Told when the panel's commit was taken.
 * @property {() => void} forced Told when the panel's commit was forced.
 * @property {() => void} dispose Told when the panel is taken down.
 */

/**
 * One panel's outlines while outlines mode is on.
 *
 * @param {OutlineHostOptions} options
 */
function createOverlay({ containerElement, containerObject, objectOf, requestFrames }) {
  /** @type {Map<Element, OutlineEntry>} */
  const entries = new Map();
  const solid = createLines(new THREE.LineBasicMaterial(overlayMaterial()));
  const dashed = createLines(
    new THREE.LineDashedMaterial({ ...overlayMaterial(), dashSize: 6, gapSize: 4 }),
  );
  const dotted = createLines(
    new THREE.LineDashedMaterial({ ...overlayMaterial(), dashSize: 1.5, gapSize: 3 }),
  );
  /** @type {Record<OutlineKind, ReturnType<typeof createLines>>} */
  const styles = { changed: solid, ripple: dashed, wasted: dotted, noop: solid };
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.add(solid.lines, dashed.lines, dotted.lines);
  containerObject.add(group);
  // The container's walk recomputes a child's world matrix only when the
  // child asks or the container moved, and a panel standing still has not.
  // Without this, an overlay made after the panel was placed, by turning the
  // mode on from the console, stays at the scene's origin.
  group.matrixWorldNeedsUpdate = true;

  /**
   * When the panel's commit was last forced, or null.
   *
   * @type {number | null}
   */
  let forcedAt = null;
  let panelWidth = 0;
  let panelHeight = 0;

  /** @type {(() => void) | null} */
  let stopFrames = null;

  const draw = () => {
    const now = performance.now();
    solid.begin();
    dashed.begin();
    dotted.begin();
    for (const [element, entry] of entries) {
      const age = now - entry.at;
      if (age >= FADE || !element.isConnected) {
        entries.delete(element);
        continue;
      }
      const object = objectOf(element);
      const matrix = object && matrixWithin(object, containerObject, toContainer);
      if (!matrix) {
        continue;
      }
      const color = entry.kind === "noop" ? NOOP_COLOR : rampColor(entry.rate);
      styles[entry.kind].push(
        matrix,
        entry.x,
        entry.y,
        entry.width,
        entry.height,
        color,
        1 - age / FADE,
      );
    }
    if (forcedAt !== null) {
      const age = now - forcedAt;
      if (age >= FADE) {
        forcedAt = null;
      } else {
        solid.push(
          toContainer.identity(),
          -FORCED_MARGIN,
          -FORCED_MARGIN,
          panelWidth + 2 * FORCED_MARGIN,
          panelHeight + 2 * FORCED_MARGIN,
          FORCED_COLOR,
          1 - age / FADE,
        );
      }
    }
    solid.end();
    dashed.end();
    dotted.end();
    if (entries.size === 0 && forcedAt === null) {
      stopFrames?.();
      stopFrames = null;
    }
  };

  /**
   * Draw now, in the frame the commit is drawn in, and on every frame after
   * until the outlines have faded.
   */
  const show = () => {
    draw();
    if (entries.size > 0 || forcedAt !== null) {
      stopFrames ??= requestFrames(draw);
    }
  };

  /**
   * A read of the mirror the overlay makes for itself, counted against
   * nothing and depended on by nothing.
   *
   * @template T
   * @param {() => T} read
   * @returns {T}
   */
  const quietly = (read) => withComputation(null, () => unprobed(read));

  return {
    commit() {
      const now = performance.now();
      takeTallies(containerElement, (element, tally) => {
        let entry = entries.get(element) ?? report.get(element);
        if (!entry) {
          entry = {
            kind: "changed",
            rate: 0,
            at: now,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            total: emptyTally(),
            commits: 0,
          };
        }
        const total = entry.total;
        total.changes += tally.changes;
        total.noopWrites += tally.noopWrites;
        total.ripples += tally.ripples;
        total.recalculated += tally.recalculated;
        total.unchanged += tally.unchanged;
        remember(element, entry);
        const kind = classify(tally);
        if (kind === null || !objectOf(element)) {
          return;
        }
        entry.rate = entry.rate * Math.exp(-(now - entry.at) / RATE_WINDOW) + 1;
        entry.kind = kind;
        entry.at = now;
        entry.commits += 1;
        const box = quietly(() => outlineBox(element));
        if (!box) {
          return;
        }
        entry.x = box.x;
        entry.y = box.y;
        entry.width = box.width;
        entry.height = box.height;
        entries.set(element, entry);
      });
      if (entries.size > 0) {
        show();
      }
    },
    forced() {
      forcedAt = performance.now();
      const size = quietly(() => getBorderBoxSize(/** @type {HTMLElement} */ (containerElement)));
      panelWidth = size.width;
      panelHeight = size.height;
      show();
    },
    dispose() {
      stopFrames?.();
      stopFrames = null;
      // What the panel counted and never committed goes with it.
      takeTallies(containerElement, () => {});
      group.removeFromParent();
      solid.dispose();
      dashed.dispose();
      dotted.dispose();
    },
  };
}

/**
 * Every panel that could draw outlines, and the overlay it draws them with
 * while outlines mode is on.
 *
 * @type {Map<OutlineHostOptions, ReturnType<typeof createOverlay> | null>}
 */
const hosts = new Map();

/**
 * What outlines mode has counted for each element since it was turned on,
 * for `outlinesReport`. Weak, so that an element the page drops is dropped
 * here as well.
 *
 * @type {WeakMap<Element, OutlineEntry>}
 */
let report = new WeakMap();

/**
 * The elements in `report`, so that it can be listed. Weak references, for
 * the reason `report` is weak.
 *
 * @type {Set<WeakRef<Element>>}
 */
let reported = new Set();

/**
 * Takes an element's reference out of `reported` once the element is
 * collected, so that a list re-rendering its rows for as long as the mode is
 * on does not grow `reported` without end.
 *
 * @type {FinalizationRegistry<WeakRef<Element>>}
 */
const collected = new FinalizationRegistry((ref) => reported.delete(ref));

/** Whether outlines mode is on. */
let enabled = false;

/**
 * Register a panel, so that it draws outlines whenever outlines mode is on.
 * Called by every portal that has frames to draw in; costs a map entry when
 * the mode is off.
 *
 * @param {OutlineHostOptions} options
 * @returns {OutlineHost}
 */
export function registerOutlineHost(options) {
  hosts.set(options, enabled ? createOverlay(options) : null);
  return {
    commit: () => hosts.get(options)?.commit(),
    forced: () => hosts.get(options)?.forced(),
    dispose: () => {
      hosts.get(options)?.dispose();
      hosts.delete(options);
    },
  };
}

/**
 * Turn outlines mode on: every panel draws a rectangle round each element
 * that changed at its last commit, styled by why and coloured by how often.
 * See "Outlines" in the README for how to read them.
 *
 * Off, the mirror pays one null check per thing it would have counted. On,
 * it pays a map lookup per thing counted, and each panel that has something
 * to show redraws its outlines on every frame until they fade. It is a
 * developer's tool, and a panel measured with it on is slower than one
 * without.
 *
 * @returns {() => void} What turns it off again.
 */
export function enableOutlinesMode() {
  if (!enabled) {
    enabled = true;
    setProbing(true);
    for (const options of hosts.keys()) {
      hosts.set(options, createOverlay(options));
    }
  }
  return disableOutlinesMode;
}

function disableOutlinesMode() {
  if (!enabled) {
    return;
  }
  enabled = false;
  setProbing(false);
  for (const [options, overlay] of hosts) {
    overlay?.dispose();
    hosts.set(options, null);
  }
  report = new WeakMap();
  reported = new Set();
}

/**
 * One row of `outlinesReport`.
 *
 * @typedef {object} OutlinesReportRow
 * @property {string} element A selector-like path to the element.
 * @property {number} commits Commits the element was drawn at.
 * @property {number} changes
 * @property {number} noopWrites
 * @property {number} ripples
 * @property {number} recalculated
 * @property {number} unchanged
 */

/**
 * What outlines mode has counted since it was turned on, one row per element
 * still in the document, the busiest first: for a headset, where nobody can
 * hover over an outline, read over remote developer tools with
 * `console.table(outlinesReport())`.
 *
 * @param {number} [limit] How many rows at most.
 * @returns {OutlinesReportRow[]}
 */
export function outlinesReport(limit = 20) {
  /** @type {{ element: Element, entry: OutlineEntry }[]} */
  const rows = [];
  for (const ref of reported) {
    const element = ref.deref();
    const entry = element && report.get(element);
    if (!element || !entry || !element.isConnected) {
      reported.delete(ref);
      continue;
    }
    rows.push({ element, entry });
  }
  rows.sort(
    (a, b) =>
      b.entry.commits - a.entry.commits || b.entry.total.recalculated - a.entry.total.recalculated,
  );
  return rows.slice(0, limit).map(({ element, entry }) => ({
    element: describe(element),
    commits: entry.commits,
    ...entry.total,
  }));
}

/**
 * Remember that `element` has a report entry, so that `outlinesReport` can
 * find it.
 *
 * @param {Element} element
 * @param {OutlineEntry} entry
 */
function remember(element, entry) {
  if (!report.has(element)) {
    const ref = new WeakRef(element);
    reported.add(ref);
    collected.register(element, ref);
  }
  report.set(element, entry);
}

/**
 * A short path to `element`, for a reader to find it by: up to three levels
 * of `describeElement`.
 *
 * @param {Element} element
 * @returns {string}
 */
function describe(element) {
  /** @type {string[]} */
  const parts = [];
  /** @type {Element | null} */
  let current = element;
  for (let depth = 0; current && depth < 3; depth++) {
    parts.unshift(describeElement(current));
    current = current.parentElement;
  }
  return parts.join(" > ");
}
