import * as THREE from "three";
import { decorate, memo } from "@apendua.dev/store4";
import { addDependency, batch, Changes, NoValueError } from "@apendua.dev/signal";
import { store } from "@apendua.dev/reactive";
import { filter, Subject } from "rxjs";

/**
 * @imprt {RectangleParams} from './rectangle.js';
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

/**
 * @param {IVisualProperties} properties
 * @returns {IVisualProperties}
 */
function normalize(properties) {
  const p = { ...properties };
  if (p.borderLeftTopRadius + p.borderLeftBottomRadius > p.totalHeight) {
    const scale = p.totalHeight / (p.borderLeftTopRadius + p.borderLeftBottomRadius);
    p.borderLeftTopRadius *= scale;
    p.borderLeftBottomRadius *= scale;
  }
  if (p.borderRightTopRadius + p.borderRightBottomRadius > p.totalHeight) {
    const scale = p.totalHeight / (p.borderRightTopRadius + p.borderRightBottomRadius);
    p.borderRightTopRadius *= scale;
    p.borderRightBottomRadius *= scale;
  }
  if (p.borderTopLeftRadius + p.borderTopRightRadius > p.totalWidth) {
    const scale = p.totalWidth / (p.borderTopLeftRadius + p.borderTopRightRadius);
    p.borderTopLeftRadius *= scale;
    p.borderTopRightRadius *= scale;
  }
  if (p.borderBottomLeftRadius + p.borderBottomRightRadius > p.totalWidth) {
    const scale = p.totalWidth / (p.borderBottomLeftRadius + p.borderBottomRightRadius);
    p.borderBottomLeftRadius *= scale;
    p.borderBottomRightRadius *= scale;
  }
  return p;
}

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
    const style = getComputedStyle(el);
    const op = parseFloat(style.opacity);
    opacity *= isNaN(op) ? 1.0 : op;
    el = el.parentElement;
    layer++;
  }
  return [opacity, layer];
}

/**
 * @implements {IVisualProperties}
 */
export default class VisualProperties {
  /** @type {IVisualProperties | undefined} */
  #properties;

  /** @type {Subject<EventType>} */
  #events;

  constructor() {
    this.#events = new Subject();
  }

  /**
   * @param {string} fontFamily
   * @param {string} fontWeight
   */
  getRelativeXHeight(fontFamily, fontWeight) {
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
    const p = this.#properties;
    return {
      left: 0,
      right: p.totalWidth,
      top: 0,
      bottom: p.totalHeight,
      leftTop: p.borderLeftTopRadius,
      leftBottom: p.totalHeight - p.borderLeftBottomRadius,
      bottomLeft: p.borderBottomLeftRadius,
      bottomRight: p.totalWidth - p.borderBottomRightRadius,
      rightBottom: p.totalHeight - p.borderRightBottomRadius,
      rightTop: p.borderRightTopRadius,
      topRight: p.totalWidth - p.borderTopRightRadius,
      topLeft: p.borderTopLeftRadius,
    };
  }

  /**
   * @param {HTMLElement} element
   */
  setFromElement(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const fontSize = parseFloat(style.fontSize);
    const [backgroundColor, backgroundAlpha] = parseColor(style.backgroundColor);
    const [borderColor, borderAlpha] = parseColor(style.borderColor);
    const [textColor, textAlpha] = parseColor(style.color);
    const [inheritedOpacity, layerNo] = getInheritedOpacity(element);
    const opacity = parseFloat(style.opacity) * inheritedOpacity;
    const xHeight = fontSize * this.getRelativeXHeight(style.fontFamily, style.fontWeight);
    /** @type {Units} */
    const unitsW = {
      px: 1,
      em: fontSize,
      ex: xHeight,
      percent: rect.width / 100,
    };
    /** @type {Units} */
    const unitsH = {
      px: 1,
      em: fontSize,
      ex: xHeight,
      percent: rect.height / 100,
    };
    /** @type {IVisualProperties} */
    const properties = normalize({
      totalWidth: rect.width,
      totalHeight: rect.height,
      fontSize,
      xHeight,
      borderLeftWidth: parseSize(style.borderLeftWidth, unitsW),
      borderRightWidth: parseSize(style.borderRightWidth, unitsW),
      borderTopWidth: parseSize(style.borderTopWidth, unitsH),
      borderBottomWidth: parseSize(style.borderBottomWidth, unitsH),
      borderBottomLeftRadius: parseSize(style.borderBottomLeftRadius, unitsW),
      borderBottomRightRadius: parseSize(style.borderBottomRightRadius, unitsW),
      borderTopLeftRadius: parseSize(style.borderTopLeftRadius, unitsW),
      borderTopRightRadius: parseSize(style.borderTopRightRadius, unitsW),
      borderLeftBottomRadius: parseSize(style.borderBottomLeftRadius, unitsH),
      borderLeftTopRadius: parseSize(style.borderTopLeftRadius, unitsH),
      borderRightBottomRadius: parseSize(style.borderBottomRightRadius, unitsH),
      borderRightTopRadius: parseSize(style.borderTopRightRadius, unitsH),
      backgroundColor: backgroundColor,
      backgroundAlpha: backgroundAlpha * opacity,
      borderColor: borderColor,
      borderAlpha: borderAlpha * opacity,
      textColor: textColor,
      textAlpha: textAlpha * opacity,
      layerNo,
    });
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
   * @returns {asserts this is {#properties: IVisualProperties}}
   */
  #assertInitialized() {
    if (!this.#properties) {
      addDependency(new Changes(this.#events.pipe(filter((e) => e === "INITIALIZED"))));
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
    return this.#properties.xHeight;
  }

  get borderLeftWidth() {
    this.#assertInitialized();
    return this.#properties.borderLeftWidth;
  }

  get borderRightWidth() {
    this.#assertInitialized();
    return this.#properties.borderRightWidth;
  }

  get borderTopWidth() {
    this.#assertInitialized();
    return this.#properties.borderTopWidth;
  }

  get borderBottomWidth() {
    this.#assertInitialized();
    return this.#properties.borderBottomWidth;
  }

  get borderBottomLeftRadius() {
    this.#assertInitialized();
    return this.#properties.borderBottomLeftRadius;
  }

  get borderBottomRightRadius() {
    this.#assertInitialized();
    return this.#properties.borderBottomRightRadius;
  }

  get borderTopLeftRadius() {
    this.#assertInitialized();
    return this.#properties.borderTopLeftRadius;
  }

  get borderTopRightRadius() {
    this.#assertInitialized();
    return this.#properties.borderTopRightRadius;
  }

  get borderLeftBottomRadius() {
    this.#assertInitialized();
    return this.#properties.borderLeftBottomRadius;
  }

  get borderLeftTopRadius() {
    this.#assertInitialized();
    return this.#properties.borderLeftTopRadius;
  }

  get borderRightBottomRadius() {
    this.#assertInitialized();
    return this.#properties.borderRightBottomRadius;
  }

  get borderRightTopRadius() {
    this.#assertInitialized();
    return this.#properties.borderRightTopRadius;
  }

  get backgroundColor() {
    this.#assertInitialized();
    return this.#properties.backgroundColor;
  }

  get backgroundAlpha() {
    this.#assertInitialized();
    return this.#properties.backgroundAlpha;
  }

  get borderColor() {
    this.#assertInitialized();
    return this.#properties.borderColor;
  }

  get borderAlpha() {
    this.#assertInitialized();
    return this.#properties.borderAlpha;
  }

  get textColor() {
    this.#assertInitialized();
    return this.#properties.textColor;
  }

  get textAlpha() {
    this.#assertInitialized();
    return this.#properties.textAlpha;
  }

  get layerNo() {
    this.#assertInitialized();
    return this.#properties.layerNo;
  }
}

decorate(VisualProperties.prototype, "getRelativeXHeight", memo());
decorate(VisualProperties.prototype, "getRectangleParams", memo());
