import * as THREE from "three";
import {
  addDependency,
  batch,
  Derived,
  NoValueError,
  memo,
  decorate,
  withChannel,
} from "@apendua/signal";
import { fromEvent, store } from "@apendua/signal";
import { filtered, Subject } from "@apendua/signal";
import { getBorderBoxSize, getComputedStyleCached, getOpacity } from "./mirror.js";

import { ELEVATION_BAND, getDrawLevel, getElevation } from "./elevation.js";
import { layoutGradient, parseBackground } from "./gradient.js";

/**
 * @import {GradientLayout} from './gradient.js';
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
 * @property {string} backgroundImage
 * @property {string} backgroundSize
 * @property {string} backgroundPositionX
 * @property {string} backgroundPositionY
 * @property {string} backgroundPosition
 * @property {string} backgroundRepeat
 * @property {string} backgroundOrigin
 * @property {string} paddingTop
 * @property {string} paddingRight
 * @property {string} paddingBottom
 * @property {string} paddingLeft
 * @property {string} borderColor
 * @property {string} textColor
 * @property {number} drawLevel
 * @property {number} elevation
 */

/**
 * @typedef {object} IVisualProperties
 * @property {number} totalWidth
 * @property {number} totalHeight
 * @property {number} xHeight
 * @property {number} fontSize
 * @property {number} opacity
 * @property {number} borderLeftWidth
 * @property {number} borderRightWidth
 * @property {number} borderTopWidth
 * @property {number} borderBottomWidth
 * @property {number} borderBottomLeftRadius
 * @property {number} borderBottomRightRadius
 * @property {number} borderTopLeftRadius
 * @property {number} borderTopRightRadius
 * @property {THREE.Color} backgroundColor
 * @property {number} backgroundAlpha
 * @property {GradientLayout | null} backgroundGradient
 * @property {THREE.Color} borderColor
 * @property {number} borderAlpha
 * @property {THREE.Color} textColor
 * @property {number} textAlpha
 * @property {number} drawLevel
 * @property {number} elevation
 */

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
 * A computed CSS colour as `getComputedStyle` serializes one: `rgb(r, g, b)`
 * or `rgba(r, g, b, a)`. The fourth group is the alpha, when there is one.
 */
const COLOR_PATTERN = /rgba?\(([^,]+),([^,]+),([^,]+)(?:,\s*([\d.]+))?\)/;

/**
 * The alpha of a computed CSS colour alone, as `parseColor` reads it, for
 * the callers that want nothing else: it builds no `THREE.Color` and does
 * not convert one to linear.
 *
 * @param {string} colorString
 * @returns {number}
 */
export function parseAlpha(colorString) {
  const match = COLOR_PATTERN.exec(colorString);
  return match?.[4] !== undefined ? parseFloat(match[4]) : 1.0;
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
  const match = COLOR_PATTERN.exec(colorString);
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
 * How tall a lowercase x stands relative to the font size, per font. One
 * probe element, one layout, per (family, weight) the whole page ever uses —
 * not per element wearing it: the probe forces a layout of its own, and a
 * panel of a hundred boxes wearing one font asked a hundred times.
 *
 * @type {Map<string, Derived<number>>}
 */
const relativeXHeights = new Map();

/**
 * @param {string} fontFamily
 * @param {string} fontWeight
 * @returns {number}
 */
function getRelativeXHeightShared(fontFamily, fontWeight) {
  const key = `${fontFamily}\u0000${fontWeight}`;
  let signal = relativeXHeights.get(key);
  if (!signal) {
    // Shared by every panel that uses this face, so it belongs to none of
    // them: built lazily, it would otherwise be captured by whichever panel
    // happened to ask first and be deferred to that panel's frames for
    // everyone.
    signal = withChannel(
      null,
      () =>
        new Derived(() => {
          // Measured with whatever fonts are at hand, never refused: a face
          // still on the wire measures as its fallback and is measured again
          // when `loadingdone` says the loading period closed. Waiting by
          // throwing was the old behaviour, and per instance it was survivable;
          // shared, it parked every box that asked during a loading window on
          // an invalidation that a *second* loading window could leave swallowed
          // — panels whose quads never drew. A briefly-fallback `ex` metric
          // corrects itself; an absent box does not.
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
        }),
    );
    relativeXHeights.set(key, signal);
  }
  return signal.get();
}

/**
 * The sides of a box, in the order CSS lists them, by the names of their
 * width and colour in a computed style.
 */
const BORDER_SIDES = /** @type {const} */ ([
  ["borderTopWidth", "borderTopColor"],
  ["borderRightWidth", "borderRightColor"],
  ["borderBottomWidth", "borderBottomColor"],
  ["borderLeftWidth", "borderLeftColor"],
]);

/** What a box is drawn with when no side of it draws a border. */
const NO_BORDER = "rgba(0, 0, 0, 0)";

/**
 * The one colour a box's border is drawn in: the colour of the first side
 * that draws one, top, right, bottom, left.
 *
 * A box is drawn with a width per side but a single border colour, and the
 * computed `border-color` shorthand is no answer to which. It lists every
 * side's colour, and a side with no border still has one, `currentColor`
 * by default. Read from the front, `border-bottom: 1px solid #eee` was the
 * text colour of the top edge, which has no border, and a divider was drawn
 * in the colour of the text. A side whose computed width is 0 is one CSS
 * draws nothing on, `border-style: none` included, so it has no say here.
 * Nor does a side that is there and transparent: a row of tabs keeps their
 * heights equal with `border-top: 2px solid transparent` over a coloured
 * `border-bottom`, and the underline is the border that is drawn. A box
 * with no side that draws one, an unchosen tab whose only border is a
 * transparent underline, is drawn with no border at all.
 *
 * Paid by every box on every restyle, so a side's colour is read only once
 * its width says it has a border, and only its alpha is parsed.
 *
 * Borders on several sides in different colours still share the first of
 * them; drawing each in its own would need a colour per side in the shader.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {string}
 */
export function getDrawnBorderColor(style) {
  for (const [width, color] of BORDER_SIDES) {
    if (parseFloat(style[width]) > 0) {
      const value = style[color];
      if (parseAlpha(value) > 0) {
        return value;
      }
    }
  }
  return NO_BORDER;
}

/**
 * @implements {IVisualProperties}
 */
export default class VisualProperties {
  /** @type {RawVisualProperties | undefined} */
  #properties;

  /** @type {Subject<EventType>} */
  #events = new Subject();

  #anyInitializedEvent = filtered(this.#events, (e) => e === "INITIALIZED");

  /**
   * @param {string} fontFamily
   * @param {string} fontWeight
   */
  getRelativeXHeight(fontFamily, fontWeight) {
    return getRelativeXHeightShared(fontFamily, fontWeight);
  }

  /**
   * @param {HTMLElement} element
   * @param {string | null} [pseudoElement]
   */
  setFromElement(element, pseudoElement = null) {
    const style = getComputedStyleCached(element, pseudoElement);
    // The mirror answers with layout offsets instead of client rects when a
    // transform sits anywhere on the chain — the box's object carries the
    // transform itself, and a transformed client rect would apply it a
    // second time. Reading the size is also the dependency that re-runs
    // this when the layout moves it.
    const size = getBorderBoxSize(element);
    const fontSize = parseFloat(style.fontSize || "0");
    // The element's own and every ancestor's in the panel, as a page fades
    // a subtree (see `getOpacity`).
    const opacity = getOpacity(element);
    // Every box pays for reading `background-image`; only a box that has one
    // pays for the properties that lay it out. They are all left empty
    // otherwise, which is a value that does not change and so notifies
    // nobody.
    const backgroundImage = style.backgroundImage || "none";
    const hasImage = backgroundImage !== "none";
    /** @type {RawVisualProperties} */
    const properties = {
      totalWidth: size.width,
      totalHeight: size.height,
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
      backgroundImage,
      backgroundSize: hasImage ? style.backgroundSize : "",
      backgroundPositionX: hasImage ? style.backgroundPositionX : "",
      backgroundPositionY: hasImage ? style.backgroundPositionY : "",
      backgroundPosition: hasImage ? style.backgroundPosition : "",
      backgroundRepeat: hasImage ? style.backgroundRepeat : "",
      backgroundOrigin: hasImage ? style.backgroundOrigin : "",
      paddingTop: hasImage ? style.paddingTop : "",
      paddingRight: hasImage ? style.paddingRight : "",
      paddingBottom: hasImage ? style.paddingBottom : "",
      paddingLeft: hasImage ? style.paddingLeft : "",
      borderColor: getDrawnBorderColor(style),
      textColor: style.color,
      drawLevel: getDrawLevel(element),
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

  /**
   * How see-through the element asked to be, before any colour of its own is
   * taken into account. The colours below fold it in already; what reads this
   * on its own is content the element carries rather than paints — a picture,
   * which has an alpha channel to be scaled rather than a CSS colour to be
   * multiplied.
   */
  get opacity() {
    return this.#props.opacity;
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

  get backgroundColor() {
    const [backgroundColor] = parseColor(this.#props.backgroundColor);
    return backgroundColor;
  }

  get backgroundAlpha() {
    return parseAlpha(this.#props.backgroundColor) * this.#props.opacity;
  }

  /**
   * The background's gradient as a description that does not depend on size
   * — parsed when the style changes and at no other time, which is why it is
   * its own memo rather than a step inside `backgroundGradient`.
   */
  get background() {
    const props = this.#props;
    if (props.backgroundImage === "none") {
      return null;
    }
    return parseBackground({
      image: props.backgroundImage,
      size: props.backgroundSize,
      positionX: props.backgroundPositionX,
      positionY: props.backgroundPositionY,
      position: props.backgroundPosition,
      repeat: props.backgroundRepeat,
      origin: props.backgroundOrigin,
      currentColor: props.textColor,
    });
  }

  /**
   * The gradient layer painted over the background colour, laid out against
   * this element's box, or `null` for none. Its colours carry no opacity: the
   * layer is composited over the background colour first and the element's
   * opacity applied to the two together, which is what CSS does and what
   * folding the opacity into each colour would get wrong.
   *
   * @returns {GradientLayout | null}
   */
  get backgroundGradient() {
    const background = this.background;
    if (!background) {
      return null;
    }
    return layoutGradient(background, {
      width: this.totalWidth,
      height: this.totalHeight,
      border: [
        this.borderTopWidth,
        this.borderRightWidth,
        this.borderBottomWidth,
        this.borderLeftWidth,
      ],
      padding: [
        parseSize(this.#props.paddingTop, this.unitsH),
        parseSize(this.#props.paddingRight, this.unitsW),
        parseSize(this.#props.paddingBottom, this.unitsH),
        parseSize(this.#props.paddingLeft, this.unitsW),
      ],
    });
  }

  get borderColor() {
    const [borderColor] = parseColor(this.#props.borderColor);
    return borderColor;
  }

  get borderAlpha() {
    return parseAlpha(this.#props.borderColor) * this.#props.opacity;
  }

  get textColor() {
    const [textColor] = parseColor(this.#props.textColor);
    return textColor;
  }

  get textAlpha() {
    return parseAlpha(this.#props.textColor) * this.#props.opacity;
  }

  get drawLevel() {
    return this.#props.drawLevel;
  }

  get elevation() {
    return this.#props.elevation;
  }

  /**
   * Where this element's meshes belong in the scene's draw order.
   *
   * The draw level decides it within a layer (`getDrawLevel`): a child
   * paints over its parent, which is what the nesting already means, and a
   * translucent box draws after the siblings it is stepped over. Between
   * layers it does not decide anything: an overlay is above everything below
   * it however shallow the overlay happens to be, so each layer takes a band
   * of its own (`ELEVATION_BAND`).
   */
  get renderOrder() {
    return this.elevation * ELEVATION_BAND + this.drawLevel;
  }
}

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
decorate(VisualProperties.prototype, "opacity", memo());
decorate(VisualProperties.prototype, "borderBottomLeftRadius", memo());
decorate(VisualProperties.prototype, "borderBottomRightRadius", memo());
decorate(VisualProperties.prototype, "borderTopLeftRadius", memo());
decorate(VisualProperties.prototype, "borderTopRightRadius", memo());
decorate(VisualProperties.prototype, "backgroundColor", memo());
decorate(VisualProperties.prototype, "backgroundAlpha", memo());
decorate(VisualProperties.prototype, "background", memo());
decorate(VisualProperties.prototype, "backgroundGradient", memo());
decorate(VisualProperties.prototype, "borderColor", memo());
decorate(VisualProperties.prototype, "borderAlpha", memo());
decorate(VisualProperties.prototype, "textColor", memo());
decorate(VisualProperties.prototype, "textAlpha", memo());
