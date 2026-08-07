import * as THREE from "three";
import { Derived, effects, observable, onCleanup, set } from "@apendua/signal";
import { distinctUntilChanged, switchMap } from "rxjs";
import { $, Nothing } from "../operators.js";
import { box } from "./div.js";
import { getCheckedCached, getComputedStyleCached } from "./cache.js";

/**
 * @import {Observable} from 'rxjs';
 * @import {Component} from '../core.js';
 * @import {BoxSurface} from './div.js';
 */

/**
 * How far in front of the background the tick is drawn, in the element's local
 * px. The background sits at +1 — see `div` — so this puts the mark just
 * short of the element's own origin, well inside the step the first child of
 * an ordinary box would take.
 */
const MARK_STEP = 1;

/**
 * The tick, as a polyline across the box it is drawn in: in from the left and
 * a little below the middle, down to the elbow, then up past the top right.
 * Fractions of the content box, so it follows whatever size the stylesheet
 * gives the control. y runs down, the portal's convention throughout.
 */
const TICK = /** @type {const} */ ([
  [0.16, 0.5],
  [0.4, 0.74],
  [0.84, 0.24],
]);

/** How thick the tick is drawn, as a fraction of the shorter side. */
const TICK_WIDTH = 0.16;

/**
 * How far a corner may be pushed out to keep the outside of a bend as sharp as
 * the polyline is. Unbounded, a fold back on itself would send the corner off
 * to infinity; the tick's elbow is nowhere near this, and clamping it keeps a
 * mark in a very flat box from growing a spike.
 */
const MITER_LIMIT = 4;

/**
 * A polyline given width: the two sides of the stroke it describes, with butt
 * ends and mitred bends. One point per side per point of the polyline, in the
 * polyline's own order, so the two arrays pair up index for index.
 *
 * @param {readonly THREE.Vector2[]} points
 * @param {number} halfWidth
 * @returns {{left: THREE.Vector2[], right: THREE.Vector2[]}}
 */
function thickenPolyline(points, halfWidth) {
  /** The left-hand normal of each segment. */
  const normals = points.slice(0, -1).map((point, i) => {
    const direction = points[i + 1].clone().sub(point).normalize();
    return new THREE.Vector2(-direction.y, direction.x);
  });
  const offsets = points.map((_, i) => {
    const before = normals[i - 1];
    const after = normals[i];
    if (!before) {
      return after.clone().multiplyScalar(halfWidth);
    }
    if (!after) {
      return before.clone().multiplyScalar(halfWidth);
    }
    // The corner sits where the two offset edges meet, which is further out
    // than either normal the sharper the bend — that is what keeps the stroke
    // the same width all the way round the outside of it.
    const miter = before.clone().add(after).normalize();
    const scale = Math.min(halfWidth / miter.dot(before), halfWidth * MITER_LIMIT);
    return miter.multiplyScalar(scale);
  });
  return {
    left: points.map((point, i) => point.clone().add(offsets[i])),
    right: points.map((point, i) => point.clone().sub(offsets[i])),
  };
}

/**
 * The tick as a mesh: one quad per segment of the polyline, spanning the pair
 * of side points at each of its ends, written straight into a buffer.
 *
 * Deliberately not `THREE.Shape` and `ShapeGeometry`. Those exist to
 * triangulate an arbitrary polygon, and importing them drags three's whole
 * shape subtree — curves, paths, the earcut triangulator — into every bundle
 * with a portal in it, some 8 kB gzipped, whether or not anything in the app
 * is a checkbox. Drawing boxes with a distance field got that subtree out of
 * the bundle; a mark whose topology is known in advance and never changes has
 * no business putting it back.
 *
 * @param {number} width
 * @param {number} height
 * @returns {THREE.BufferGeometry}
 */
function makeTickGeometry(width, height) {
  const points = TICK.map(([x, y]) => new THREE.Vector2(x * width, y * height));
  const halfWidth = (TICK_WIDTH * Math.min(width, height)) / 2;
  const { left, right } = thickenPolyline(points, halfWidth);

  // The two sides interleaved, so that a point's pair sits together: the left
  // vertex at 2i, the right one after it.
  const positions = new Float32Array(points.length * 6);
  for (let i = 0; i < points.length; i++) {
    positions.set([left[i].x, left[i].y, 0], i * 6);
    positions.set([right[i].x, right[i].y, 0], i * 6 + 3);
  }

  /** @type {number[]} */
  const indices = [];
  for (let i = 0; i < points.length - 1; i++) {
    indices.push(2 * i, 2 * i + 2, 2 * i + 3, 2 * i, 2 * i + 3, 2 * i + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // No normals or UVs: the mark is drawn with a flat, two-sided, unmapped
  // material, which reads neither.
  return geometry;
}

/**
 * The tick, drawn in the element's own `color` — the same declaration that
 * would colour text in it, which is as close as CSS comes to naming the mark.
 *
 * The material is created once and tinted in an effect of its own, the way
 * text's is: `color` is the property most likely to be animated on a control,
 * and a colour change should cost a uniform write rather than a new material.
 *
 * @param {BoxSurface} surface
 * @returns {Observable<Component>}
 */
function tick({ properties, contentRenderOrder }) {
  return $(new THREE.Mesh(), [
    set("material", () => {
      const material = new THREE.MeshBasicMaterial({
        // Two-sided, and not writing depth, for the same reasons everything
        // else in a portal is: the container's flip turns every plane away
        // from the viewer, and a mark that wrote depth would keep out
        // whatever the draw order puts in front of it.
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      });
      onCleanup(() => {
        material.dispose();
      });
      return material;
    }),
    set("geometry", () => {
      const geometry = makeTickGeometry(
        properties.totalWidth - properties.borderLeftWidth - properties.borderRightWidth,
        properties.totalHeight - properties.borderTopWidth - properties.borderBottomWidth,
      );
      onCleanup(() => {
        geometry.dispose();
      });
      return geometry;
    }),
    effects((obj) => {
      const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
      material.color.copy(properties.textColor);
      material.opacity = properties.textAlpha;
    }),
    effects((obj) => {
      obj.position.set(properties.borderLeftWidth, properties.borderTopWidth, 1 - MARK_STEP);
      // The box's own draw order plus one: transparency is sorted rather than
      // depth-tested, so a mark that drew before the surface it sits on would
      // blend its edges with whatever is behind the panel.
      obj.renderOrder = contentRenderOrder();
    }),
  ]);
}

/**
 * `<input type="checkbox">`, projected into the scene.
 *
 * A checkbox is the one native control that a portal can mirror honestly: it
 * is a box with a mark in it, and both the box and whether the mark is there
 * are things a scene can be told. What it cannot mirror is the mark the
 * browser draws — that is chrome, like a `<select>`'s popup, and never reaches
 * the DOM — so the box comes from `div`'s and the tick is drawn here.
 *
 * The one difference from the CSS is that `appearance: none` is implied: there
 * is no native look to keep. Style it the way a flat page would be styled and
 * both builds agree — border, background, `border-radius`, `color` for the
 * tick, and `:checked` for the ticked state.
 *
 * @param {WeakKey} ctx
 * @param {HTMLInputElement} element
 * @returns {Observable<THREE.Object3D>}
 */
export function checkbox(ctx, element) {
  const checked = new Derived(() => getCheckedCached(element));

  return box(ctx, element, {
    // A control is there to be operated. An ordinary box has to say it is
    // clickable through `cursor: pointer`, because nothing else tells a button
    // apart from the card it sits on; a checkbox needs no such declaration,
    // and a disabled one is not a ray target however it is dressed.
    clickable: (el) => {
      // Read for its invalidation as much as its value: a control is usually
      // enabled or disabled along with a class or an attribute, and this is
      // what carries that news in a portal.
      getComputedStyleCached(el);
      return !(/** @type {HTMLInputElement} */ (el).disabled);
    },
    content: (surface) => [
      observable(() => checked.get()).pipe(
        distinctUntilChanged(),
        switchMap((isChecked) => (isChecked ? tick(surface) : Nothing())),
      ),
    ],
  }).pipe(
    // `:checked` is a pseudo-class, and a pseudo-class changes no attribute —
    // so nothing would tell the portal to re-read a style that follows it, and
    // a box that turns blue when ticked would stay the colour it started.
    // Writing the state back as an attribute is what the hover and active
    // states already do, and it invalidates the same neighbourhood any other
    // attribute mutation on this element would. It doubles as
    // `[data-xr-checked]`, for a rule that should apply in a scene and not on
    // the page.
    effects(() => {
      if (!checked.get()) {
        return;
      }
      element.dataset.xrChecked = "true";
      onCleanup(() => {
        delete element.dataset.xrChecked;
      });
    }),
  );
}
