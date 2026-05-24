import * as THREE from "three";
import { decorate, memo } from "@apendua.dev/store4";
import { addDependency, batch, NoValueError } from "@apendua.dev/signal";
import { fromEvent, store } from "@apendua.dev/signal";
import { filter, from, Subject } from "rxjs";
import { getBoundingClientRectCached, getComputedStyleCached } from "./cache.js";

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
 * @param {string} colorString
 * @returns {[THREE.Color, number]}
 */
function parseColor(colorString) {
  const match = colorString.match(/rgba?\(([^,]+),([^,]+),([^,]+)(?:,\s*([\d.]+))?\)/);
  if (!match) {
    const color = new THREE.Color();
    return [color, 1.0];
  }
  const r = parseInt(match[1], 10) / 255;
  const g = parseInt(match[2], 10) / 255;
  const b = parseInt(match[3], 10) / 255;
  const a = match[4] !== undefined ? parseFloat(match[4]) : 1.0;
  const color = new THREE.Color(r, g, b);
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
    const fontSize = parseFloat(style.fontSize || "0");
    const [inheritedOpacity, layerNo] = getInheritedOpacity(element);
    const opacity = parseFloat(style.opacity || "1") * inheritedOpacity;
    /** @type {RawVisualProperties} */
    const properties = {
      totalWidth: rect.width,
      totalHeight: rect.height,
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

  /**
   * @returns {asserts this is {#properties: RawVisualProperties}}
   */
  #assertInitialized() {
    if (!this.#properties) {
      addDependency(this.#anyInitializedEvent);
      throw new NoValueError("VisualProperties not initialized");
    }
  }

  get totalWidth() {
    this.#assertInitialized();
    return this.#properties.totalWidth;
  }

  get totalHeight() {
    this.#assertInitialized();
    return this.#properties.totalHeight;
  }

  get fontSize() {
    this.#assertInitialized();
    return this.#properties.fontSize;
  }

  get xHeight() {
    this.#assertInitialized();
    return this.getRelativeXHeight(this.#properties.fontFamily, this.#properties.fontWeight);
  }

  /**
   * @returns {Units}
   */
  get unitsW() {
    this.#assertInitialized();
    return {
      px: 1,
      em: this.#properties.fontSize,
      ex: this.xHeight,
      percent: this.totalWidth / 100,
    };
  }

  /**
   * @returns {Units}
   */
  get unitsH() {
    this.#assertInitialized();
    return {
      px: 1,
      em: this.#properties.fontSize,
      ex: this.xHeight,
      percent: this.totalHeight / 100,
    };
  }

  get borderLeftWidth() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderLeftWidth, this.unitsW);
  }

  get borderRightWidth() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderRightWidth, this.unitsW);
  }

  get borderTopWidth() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderTopWidth, this.unitsH);
  }

  get borderBottomWidth() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderBottomWidth, this.unitsH);
  }

  get borderBottomLeftRadius() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderBottomLeftRadius, this.unitsW);
  }

  get borderBottomRightRadius() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderBottomRightRadius, this.unitsW);
  }

  get borderTopLeftRadius() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderTopLeftRadius, this.unitsW);
  }

  get borderTopRightRadius() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderTopRightRadius, this.unitsW);
  }

  get borderLeftBottomRadius() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderBottomLeftRadius, this.unitsH);
  }

  get borderLeftTopRadius() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderTopLeftRadius, this.unitsH);
  }

  get borderRightBottomRadius() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderBottomRightRadius, this.unitsH);
  }

  get borderRightTopRadius() {
    this.#assertInitialized();
    return parseSize(this.#properties.borderTopRightRadius, this.unitsH);
  }

  get backgroundColor() {
    this.#assertInitialized();
    const [backgroundColor] = parseColor(this.#properties.backgroundColor);
    return backgroundColor;
  }

  get backgroundAlpha() {
    this.#assertInitialized();
    const [, backgroundAlpha] = parseColor(this.#properties.backgroundColor);
    return backgroundAlpha * this.#properties.opacity;
  }

  get borderColor() {
    this.#assertInitialized();
    const [borderColor] = parseColor(this.#properties.borderColor);
    return borderColor;
  }

  get borderAlpha() {
    this.#assertInitialized();
    const [, borderAlpha] = parseColor(this.#properties.borderColor);
    return borderAlpha * this.#properties.opacity;
  }

  get textColor() {
    this.#assertInitialized();
    const [textColor] = parseColor(this.#properties.textColor);
    return textColor;
  }

  get textAlpha() {
    this.#assertInitialized();
    const [, textAlpha] = parseColor(this.#properties.textColor);
    return textAlpha * this.#properties.opacity;
  }

  get layerNo() {
    this.#assertInitialized();
    return this.#properties.layerNo;
  }
}

decorate(VisualProperties.prototype, "getRelativeXHeight", memo());
decorate(VisualProperties.prototype, "getRectangleParams", memo());
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
