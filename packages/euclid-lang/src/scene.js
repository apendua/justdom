import { Point, Line, Circle, BBox } from "@apendua.dev/euclid-core";

/**
 * @import { StatementNode } from "./parser.js"
 * @import { Evaluation } from "./interpreter.js"
 * @import { Value } from "./values.js"
 */

/**
 * @typedef {object} SceneItem
 * @property {string} id A stable identifier within the scene.
 * @property {string | null} name The variable name, when the item comes from one.
 * @property {"point" | "line" | "circle" | "polygon"} kind
 * @property {Point | Line | Circle | Point[]} value
 * @property {boolean} drawn Whether the item was explicitly drawn (vs. merely defined).
 * @property {Record<string, Value>} options Options of the draw statement, when drawn.
 * @property {StatementNode} statement The statement the item originates from.
 */

/**
 * @typedef {object} Scene
 * @property {SceneItem[]} items
 * @property {BBox} bbox The bounding box of the finite real points of the scene.
 */

/**
 * @param {Value} value
 * @returns {"point" | "line" | "circle" | null}
 */
function kindOf(value) {
  if (value instanceof Point) {
    return "point";
  }
  if (value instanceof Line) {
    return "line";
  }
  if (value instanceof Circle) {
    return "circle";
  }
  return null;
}

/**
 * @param {Point | Line | Circle | Point[]} value
 * @returns {boolean}
 */
function isDrawableValue(value) {
  if (Array.isArray(value)) {
    return value.every((p) => p instanceof Point && p.isFinite() && p.isReal());
  }
  if (value instanceof Point) {
    return value.isFinite() && value.isReal();
  }
  if (value instanceof Line) {
    return !value.isAtInfinity() && value.isReal();
  }
  if (value instanceof Circle) {
    return value.isReal() && Number.isFinite(value.radius()) && value.radius() > 0;
  }
  return false;
}

/**
 * Assembles the renderable scene out of an evaluation: every renderable
 * definition becomes an item, and `draw` statements mark items as drawn (or
 * add anonymous ones for expressions that are not just a name).
 *
 * Items that cannot be rendered — points at infinity, complex objects — are
 * left out.
 *
 * @param {Evaluation} evaluation
 * @returns {Scene}
 */
export function buildScene(evaluation) {
  /** @type {SceneItem[]} */
  const items = [];

  /** @type {Map<string, SceneItem>} */
  const byName = new Map();

  for (const definition of evaluation.definitions.values()) {
    const kind = kindOf(definition.value);
    if (!kind) {
      continue;
    }
    const value = /** @type {Point | Line | Circle} */ (definition.value);
    if (!isDrawableValue(value)) {
      continue;
    }
    /** @type {SceneItem} */
    const item = {
      id: `name:${definition.name}`,
      name: definition.name,
      kind,
      value,
      drawn: evaluation.drawAll,
      options: {},
      statement: definition.statement,
    };
    items.push(item);
    byName.set(definition.name, item);
  }

  let anonymous = 0;
  for (const drawnItem of evaluation.drawn) {
    const statement = drawnItem.statement;
    if (statement.kind === "draw" && statement.expression && statement.expression.kind === "name") {
      const existing = byName.get(statement.expression.name);
      if (existing) {
        existing.drawn = true;
        existing.options = { ...existing.options, ...drawnItem.options };
        continue;
      }
    }
    if (Array.isArray(drawnItem.value)) {
      const points = drawnItem.value.filter(
        (p) => p instanceof Point && p.isFinite() && p.isReal(),
      );
      if (points.length > 1) {
        items.push({
          id: `drawn:${anonymous}`,
          name: null,
          kind: "polygon",
          value: /** @type {Point[]} */ (points),
          drawn: true,
          options: drawnItem.options,
          statement,
        });
        anonymous += 1;
      }
      continue;
    }
    const kind = kindOf(drawnItem.value);
    if (kind && isDrawableValue(/** @type {Point | Line | Circle} */ (drawnItem.value))) {
      items.push({
        id: `drawn:${anonymous}`,
        name: null,
        kind,
        value: /** @type {Point | Line | Circle} */ (drawnItem.value),
        drawn: true,
        options: drawnItem.options,
        statement,
      });
      anonymous += 1;
    }
  }

  let bbox = new BBox();
  for (const item of items) {
    if (item.value instanceof Point) {
      const { x, y } = item.value.affine();
      bbox = bbox.addPoint(x.re, y.re);
    } else if (item.value instanceof Circle) {
      const center = item.value.center();
      if (center.isFinite() && center.isReal()) {
        const { x, y } = center.affine();
        const r = item.value.radius();
        bbox = bbox.addPoint(x.re - r, y.re - r).addPoint(x.re + r, y.re + r);
      }
    } else if (Array.isArray(item.value)) {
      for (const p of item.value) {
        const { x, y } = p.affine();
        bbox = bbox.addPoint(x.re, y.re);
      }
    }
    // Lines do not contribute to the bounding box — they are unbounded.
  }

  return { items, bbox };
}
