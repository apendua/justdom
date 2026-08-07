import * as THREE from "three";
import { addDependency, batch, NoValueError, memo, decorate, memoFn } from "@apendua/signal";
import { fromEvent, store } from "@apendua/signal";
import { filter, from, Subject } from "rxjs";
import { getBoundingClientRectCached, getComputedStyleCached } from "./cache.js";
import { isTransformed } from "./cssTransform.js";
import { getElevation } from "./elevation.js";

/**
 * @imprt {RectangleParams} from './rectangle.js';
 */

/**
 * @typedef {object} RawVisualProperties
 * @property {number} totalWidth
 * @property {number} totalHeight
 * @property {number} opacity
 * @property {number} fontSize
 * @property {string} fontFamily
 * @property {string} fontWeight
 * @property {string} borderLeftWidth
 * @property {string} borderRightWidth
 * @property {string} borderTopWidth
 * @property {string} borderBottomWidth
 * @property {string} borderBottomLeftRadius
 * @property {string} borderBottomRightRadius
 * @property {string} borderTopLeftRadius
 * @property {string} borderTopRightRadius
 * @property {string} backgroundColor
 * @property {string} borderColor
 * @property {string} textColor
 * @property {number} layerNo
 * @property {number} elevation
 */

/**
 * @typedef {object} IVisualProperties
 * @property {number} totalWidth
 * @property {number} totalHeight
 * @property {number} xHeight
 * @property {number} fontSize
 * @property {number} borderLeftWidth
 * @property {number} borderRightWidth
 * @property {number} borderTopWidth
 * @property {number} borderBottomWidth
 * @property {number} borderBottomLeftRadius
 * @property {number} borderBottomRightRadius
 * @property {number} borderTopLeftRadius
 * @property {number} borderTopRightRadius
 * @property {number} borderLeftBottomRadius
 * @property {number} borderLeftTopRadius
 * @property {number} borderRightBottomRadius
 * @property {number} borderRightTopRadius
 * @property {THREE.Color} backgroundColor
 * @property {number} backgroundAlpha
 * @property {THREE.Color} borderColor
 * @property {number} borderAlpha
 * @property {THREE.Color} textColor
 * @property {number} textAlpha
 * @property {number} layerNo
 * @property {number} elevation
 */

// /**
//  * @param {IVisualProperties} properties
//  * @returns {IVisualProperties}
//  */
// function normalize(properties) {
//   const p = { ...properties };
//   if (p.borderLeftTopRadius + p.borderLeftBottomRadius > p.totalHeight) {
//     const scale = p.totalHeight / (p.borderLeftTopRadius + p.borderLeftBottomRadius);
//     p.borderLeftTopRadius *= scale;
//     p.borderLeftBottomRadius *= scale;
//   }
//   if (p.borderRightTopRadius + p.borderRightBottomRadius > p.totalHeight) {
//     const scale = p.totalHeight / (p.borderRightTopRadius + p.borderRightBottomRadius);
//     p.borderRightTopRadius *= scale;
//     p.borderRightBottomRadius *= scale;
//   }
//   if (p.borderTopLeftRadius + p.borderTopRightRadius > p.totalWidth) {
//     const scale = p.totalWidth / (p.borderTopLeftRadius + p.borderTopRightRadius);
//     p.borderTopLeftRadius *= scale;
//     p.borderTopRightRadius *= scale;
//   }
//   if (p.borderBottomLeftRadius + p.borderBottomRightRadius > p.totalWidth) {
//     const scale = p.totalWidth / (p.borderBottomLeftRadius + p.borderBottomRightRadius);
//     p.borderBottomLeftRadius *= scale;
//     p.borderBottomRightRadius *= scale;
//   }
//   return p;
// }

/**
 * @typedef {'INITIALIZED'} EventType
 */

/**
 * @typedef {object} Units
 * @property {number} px
 * @property {number} em
 * @property {number} ex
 * @property {number} percent
 */

/**
 * @param {string} value
 * @param {Units} units
 * @returns {number}
 */
function parseSize(value, units) {
  if (!value) {
    return 0;
  }
  if (value.endsWith("px")) {
    return parseFloat(value) * units.px;
  } else if (value.endsWith("em")) {
    return parseFloat(value) * units.em;
  } else if (value.endsWith("ex")) {
    return parseFloat(value) * units.ex;
  } else if (value.endsWith("%")) {
    return parseFloat(value) * units.percent;
  }
  return parseFloat(value) * units.px;
}

/**
 * A computed CSS colour, as the colour three.js should draw and the alpha it
 * should draw it with.
 *
 * The channels are read as sRGB, which is what CSS means by them. Handing the
 * three numbers straight to `new THREE.Color(r, g, b)` would instead declare
 * them to be linear — the working space — and every colour authored in a
 * stylesheet would arrive on screen lighter and flatter than it was written,
 * dark panels worst of all.
 *
 * @param {string} colorString
 * @returns {[THREE.Color, number]}
 */
export function parseColor(colorString) {
  const match = colorString.match(/rgba?\(([^,]+),([^,]+),([^,]+)(?:,\s*([\d.]+))?\)/);
  if (!match) {
    const color = new THREE.Color();
    return [color, 1.0];
  }
  const r = parseInt(match[1], 10) / 255;
  const g = parseInt(match[2], 10) / 255;
  const b = parseInt(match[3], 10) / 255;
  const a = match[4] !== undefined ? parseFloat(match[4]) : 1.0;
  const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  return [color, a];
}

/**
 * @param {HTMLElement} element
 * @returns {[number, number]}
 */
function getInheritedOpacity(element) {
  let opacity = 1.0;
  /** @type {HTMLElement | null} */
  let el = element.parentElement;
  let layer = 0;
  while (el) {
    // const style = getComputedStyle(el);
    // const op = parseFloat(style.opacity || "1");
    // opacity *= isNaN(op) ? 1.0 : op;
    el = el.parentElement;
    layer++;
  }
  return [opacity, layer];
}

/**
 * @implements {IVisualProperties}
 */
export default class VisualProperties {
  /** @type {RawVisualProperties | undefined} */
  #properties;

  /** @type {Subject<EventType>} */
  #events = new Subject();

  #anyInitializedEvent = this.#events.pipe(filter((e) => e === "INITIALIZED"));

  /**
   * @param {string} fontFamily
   * @param {string} fontWeight
   */
  getRelativeXHeight(fontFamily, fontWeight) {
    if (document.fonts.status !== "loaded") {
      addDependency(from(document.fonts.ready));
      throw new NoValueError("Fonts not loaded");
    }
    addDependency(fromEvent(document.fonts, "loadingdone"));
    const element = document.createElement("span");
    element.style.fontFamily = fontFamily;
    element.style.fontWeight = fontWeight;
    element.style.fontSize = "100px";
    element.style.position = "absolute";
    element.style.top = "-9999px";
    element.style.left = "-9999px";
    element.style.lineHeight = "normal";
    element.textContent = "x";
    document.body.appendChild(element);
    const rect = element.getBoundingClientRect();
    document.body.removeChild(element);
    return rect.height / 100;
  }

  getRectangleParams() {
    this.#assertInitialized();
    return {
      left: 0,
      right: this.totalWidth,
      top: 0,
      bottom: this.totalHeight,
      leftTop: this.borderLeftTopRadius,
      leftBottom: this.totalHeight - this.borderLeftBottomRadius,
      bottomLeft: this.borderBottomLeftRadius,
      bottomRight: this.totalWidth - this.borderBottomRightRadius,
      rightBottom: this.totalHeight - this.borderRightBottomRadius,
      rightTop: this.borderRightTopRadius,
      topRight: this.totalWidth - this.borderTopRightRadius,
      topLeft: this.borderTopLeftRadius,
    };
  }

  /**
   * @param {HTMLElement} element
   * @param {string | null} [pseudoElement]
   */
  setFromElement(element, pseudoElement = null) {
    const style = getComputedStyleCached(element, pseudoElement);
    const rect = getBoundingClientRectCached(element);
    // A client rect includes CSS transforms; the box the mirror draws must
    // not — its object carries the transform itself, and would apply it a
    // second time. Layout sizes are whole px, but transform-free, so they
    // take over whenever a transform sits anywhere on the chain. The rect is
    // still read either way: it is the dependency that re-runs this when the
    // layout moves.
    const transformed = isTransformed(element);
    const fontSize = parseFloat(style.fontSize || "0");
    const [inheritedOpacity, layerNo] = getInheritedOpacity(element);
    const opacity = parseFloat(style.opacity || "1") * inheritedOpacity;
    /** @type {RawVisualProperties} */
    const properties = {
      totalWidth: transformed ? element.offsetWidth : rect.width,
      totalHeight: transformed ? element.offsetHeight : rect.height,
      opacity,
      fontSize,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      borderLeftWidth: style.borderLeftWidth,
      borderRightWidth: style.borderRightWidth,
      borderTopWidth: style.borderTopWidth,
      borderBottomWidth: style.borderBottomWidth,
      borderBottomLeftRadius: style.borderBottomLeftRadius,
      borderBottomRightRadius: style.borderBottomRightRadius,
      borderTopLeftRadius: style.borderTopLeftRadius,
      borderTopRightRadius: style.borderTopRightRadius,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      textColor: style.color,
      layerNo,
      elevation: getElevation(element),
    };
    batch(() => {
      if (this.#properties) {
        Object.assign(this.#properties, properties);
      } else {
        this.#properties = store(properties);
      }
    });
    this.#events.next("INITIALIZED");
  }

  #assertInitialized() {
    if (!this.#properties) {
      addDependency(this.#anyInitializedEvent);
      throw new NoValueError("VisualProperties not initialized");
    }
  }

  /**
   * Typed read access to #properties. This used to be expressed as
   * "@returns {asserts this is {#properties: RawVisualProperties}}" on
   * #assertInitialized, but a private name is not valid inside a type
   * literal; TypeScript 6 accepted it, TypeScript 7 reports TS18016. The
   * guard is the same one #assertInitialized applies, so reading through
   * this getter throws identically when the instance is uninitialized.
   *
   * @returns {RawVisualProperties}
   */
  get #props() {
    this.#assertInitialized();
    return /** @type {RawVisualProperties} */ (this.#properties);
  }

  get totalWidth() {
    return this.#props.totalWidth;
  }

  get totalHeight() {
    return this.#props.totalHeight;
  }

  get fontSize() {
    return this.#props.fontSize;
  }

  get xHeight() {
    return this.getRelativeXHeight(this.#props.fontFamily, this.#props.fontWeight);
  }

  /**
   * @returns {Units}
   */
  get unitsW() {
    return {
      px: 1,
      em: this.#props.fontSize,
      ex: this.xHeight,
      percent: this.totalWidth / 100,
    };
  }

  /**
   * @returns {Units}
   */
  get unitsH() {
    return {
      px: 1,
      em: this.#props.fontSize,
      ex: this.xHeight,
      percent: this.totalHeight / 100,
    };
  }

  get borderLeftWidth() {
    return parseSize(this.#props.borderLeftWidth, this.unitsW);
  }

  get borderRightWidth() {
    return parseSize(this.#props.borderRightWidth, this.unitsW);
  }

  get borderTopWidth() {
    return parseSize(this.#props.borderTopWidth, this.unitsH);
  }

  get borderBottomWidth() {
    return parseSize(this.#props.borderBottomWidth, this.unitsH);
  }

  get borderBottomLeftRadius() {
    return parseSize(this.#props.borderBottomLeftRadius, this.unitsW);
  }

  get borderBottomRightRadius() {
    return parseSize(this.#props.borderBottomRightRadius, this.unitsW);
  }

  get borderTopLeftRadius() {
    return parseSize(this.#props.borderTopLeftRadius, this.unitsW);
  }

  get borderTopRightRadius() {
    return parseSize(this.#props.borderTopRightRadius, this.unitsW);
  }

  get borderLeftBottomRadius() {
    return parseSize(this.#props.borderBottomLeftRadius, this.unitsH);
  }

  get borderLeftTopRadius() {
    return parseSize(this.#props.borderTopLeftRadius, this.unitsH);
  }

  get borderRightBottomRadius() {
    return parseSize(this.#props.borderBottomRightRadius, this.unitsH);
  }

  get borderRightTopRadius() {
    return parseSize(this.#props.borderTopRightRadius, this.unitsH);
  }

  get backgroundColor() {
    const [backgroundColor] = parseColor(this.#props.backgroundColor);
    return backgroundColor;
  }

  get backgroundAlpha() {
    const [, backgroundAlpha] = parseColor(this.#props.backgroundColor);
    return backgroundAlpha * this.#props.opacity;
  }

  get borderColor() {
    const [borderColor] = parseColor(this.#props.borderColor);
    return borderColor;
  }

  get borderAlpha() {
    const [, borderAlpha] = parseColor(this.#props.borderColor);
    return borderAlpha * this.#props.opacity;
  }

  get textColor() {
    const [textColor] = parseColor(this.#props.textColor);
    return textColor;
  }

  get textAlpha() {
    const [, textAlpha] = parseColor(this.#props.textColor);
    return textAlpha * this.#props.opacity;
  }

  get layerNo() {
    return this.#props.layerNo;
  }

  get elevation() {
    return this.#props.elevation;
  }

  /**
   * Where this element's meshes belong in the scene's draw order.
   *
   * Depth in the tree decides it within a layer — a child paints over its
   * parent, which is what the nesting already means. Between layers it does
   * not decide anything: an overlay is above everything below it however
   * shallow the overlay happens to be, so each layer takes a band of its own
   * wide enough that no plausible tree can climb out of one.
   */
  get renderOrder() {
    return this.elevation * 1000 + this.layerNo;
  }
}

decorate(VisualProperties.prototype, "getRelativeXHeight", memoFn());
decorate(VisualProperties.prototype, "getRectangleParams", memoFn());
decorate(VisualProperties.prototype, "totalWidth", memo());
decorate(VisualProperties.prototype, "totalHeight", memo());
decorate(VisualProperties.prototype, "fontSize", memo());
decorate(VisualProperties.prototype, "xHeight", memo());
decorate(VisualProperties.prototype, "unitsW", memo());
decorate(VisualProperties.prototype, "unitsH", memo());
decorate(VisualProperties.prototype, "borderLeftWidth", memo());
decorate(VisualProperties.prototype, "borderRightWidth", memo());
decorate(VisualProperties.prototype, "borderTopWidth", memo());
decorate(VisualProperties.prototype, "borderBottomWidth", memo());
decorate(VisualProperties.prototype, "borderBottomLeftRadius", memo());
decorate(VisualProperties.prototype, "borderBottomRightRadius", memo());
decorate(VisualProperties.prototype, "borderTopLeftRadius", memo());
decorate(VisualProperties.prototype, "borderTopRightRadius", memo());
decorate(VisualProperties.prototype, "borderLeftBottomRadius", memo());
decorate(VisualProperties.prototype, "borderLeftTopRadius", memo());
decorate(VisualProperties.prototype, "borderRightBottomRadius", memo());
decorate(VisualProperties.prototype, "borderRightTopRadius", memo());
decorate(VisualProperties.prototype, "backgroundColor", memo());
decorate(VisualProperties.prototype, "backgroundAlpha", memo());
decorate(VisualProperties.prototype, "borderColor", memo());
decorate(VisualProperties.prototype, "borderAlpha", memo());
decorate(VisualProperties.prototype, "textColor", memo());
decorate(VisualProperties.prototype, "textAlpha", memo());
