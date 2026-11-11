import { nodeCache } from "./nodeCaches.js";
import { frameFor, getGeometryGeneration, measureClientRect } from "../panelFrame.js";

/**
 * @import {FramedRect} from '../panelFrame.js';
 */

/** @type {WeakMap<Element, { generation: number, rect: FramedRect }>} */
const clientRectCache = nodeCache();

/**
 * The element's client rect in its panel's layout px (see `panelFrame.js`),
 * at most once per geometry generation. A plain read with no dependencies —
 * the reactive layer decides *when* to come back, this only keeps it from
 * asking the browser the same question twice in one settling.
 *
 * @param {Element} element
 * @returns {FramedRect}
 */
export function readClientRect(element) {
  const generation = getGeometryGeneration();
  const cached = clientRectCache.get(element);
  if (cached && cached.generation === generation) {
    return cached.rect;
  }
  const rect = measureClientRect(element, frameFor(element));
  clientRectCache.set(element, { generation, rect });
  return rect;
}
