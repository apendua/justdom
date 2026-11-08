/**
 * One reader for every colour a computed style can hold, and the conversions
 * between the colour spaces CSS names.
 *
 * A browser computes the legacy syntaxes (`rgb()`, `hsl()`, `hwb()`, hex and
 * names) to `rgb()`/`rgba()`, but keeps the others as written: `oklch()`,
 * `oklab()`, `lab()`, `lch()` and `color()` reach `getComputedStyle` as the
 * author spelled them, and `color-mix()` reaches it as `color(srgb …)`. jsdom
 * hands back most of what was authored. So this reads all of them, and turns
 * each into the sRGB channels a panel draws with.
 *
 * The conversions are the ones CSS Color 4 publishes: every RGB space goes
 * through linear light and CIE XYZ, Lab and LCH through XYZ with a D50 white,
 * and Oklab and Oklch through the LMS cone space. Only the forward matrices
 * are written out; their inverses are computed once, below. Nothing here
 * touches the DOM or a canvas.
 *
 * A colour outside sRGB, a saturated `display-p3` red say, is clipped per
 * channel, since the panel draws in sRGB. CSS asks for gamut mapping by
 * chroma reduction in Oklch instead, which a clip only approximates; the
 * difference shows only for colours sRGB cannot hold.
 */

/**
 * A colour in sRGB channels, 0–1, straight (not premultiplied) alpha.
 *
 * @typedef {[number, number, number, number]} RGBA
 */

/**
 * @typedef {[number, number, number]} Triple
 */

/**
 * @typedef {[Triple, Triple, Triple]} Matrix
 */

/**
 * The spaces a gradient can be told to interpolate in (`in <space>`). The
 * polar ones carry a hue, at the index `HUE_INDEX` gives.
 *
 * @typedef {"srgb" | "srgb-linear" | "display-p3" | "a98-rgb" | "prophoto-rgb" | "rec2020" | "lab" | "oklab" | "xyz-d50" | "xyz-d65" | "hsl" | "hwb" | "lch" | "oklch"} ColorSpace
 */

/**
 * @typedef {"shorter" | "longer" | "increasing" | "decreasing"} HueMethod
 */

/**
 * @param {Matrix} m
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Triple}
 */
function multiply(m, x, y, z) {
  return [
    m[0][0] * x + m[0][1] * y + m[0][2] * z,
    m[1][0] * x + m[1][1] * y + m[1][2] * z,
    m[2][0] * x + m[2][1] * y + m[2][2] * z,
  ];
}

/**
 * @param {Matrix} m
 * @returns {Matrix}
 */
function invert(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/** @type {Matrix} */
const SRGB_TO_XYZ = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];

/** @type {Matrix} */
const P3_TO_XYZ = [
  [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
  [35783 / 156275, 247089 / 357200, 198249 / 2500400],
  [0, 32229 / 714400, 5220557 / 5000800],
];

/** @type {Matrix} */
const A98_TO_XYZ = [
  [573536 / 994567, 263643 / 1420810, 187206 / 994567],
  [591459 / 1989134, 6239551 / 9945670, 374412 / 4972835],
  [53769 / 1989134, 351524 / 4972835, 4929758 / 4972835],
];

/** ProPhoto's primaries are relative to D50. */
/** @type {Matrix} */
const PROPHOTO_TO_XYZ_D50 = [
  [0.7977666449006423, 0.1351812974005331, 0.0313477341283922],
  [0.2880748288194013, 0.711835234241873, 0.00008993693872564],
  [0, 0, 0.8251046025104602],
];

/** @type {Matrix} */
const REC2020_TO_XYZ = [
  [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
  [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
  [0, 19567812 / 697040785, 295819943 / 278816314],
];

/** Bradford chromatic adaptation, D50 to D65. */
/** @type {Matrix} */
const D50_TO_D65 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];

/** @type {Matrix} */
const XYZ_TO_LMS = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];

/** @type {Matrix} */
const LMS_TO_OKLAB = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];

const XYZ_TO_SRGB = invert(SRGB_TO_XYZ);
const D65_TO_D50 = invert(D50_TO_D65);
const LMS_TO_XYZ = invert(XYZ_TO_LMS);
const OKLAB_TO_LMS = invert(LMS_TO_OKLAB);

/** The D50 white point, as XYZ. */
const D50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

const LAB_KAPPA = 24389 / 27;
const LAB_EPSILON = 216 / 24389;

/**
 * Transfer functions, each a pair: encoded to linear light and back. All of
 * them extend to negative values by symmetry, as CSS asks.
 *
 * @typedef {{ decode: (c: number) => number, encode: (c: number) => number }} Transfer
 */

/**
 * @param {(c: number) => number} f
 * @returns {(c: number) => number}
 */
function symmetric(f) {
  return (c) => (c < 0 ? -f(-c) : f(c));
}

/** @type {Transfer} */
const SRGB_TRANSFER = {
  decode: symmetric((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))),
  encode: symmetric((c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)),
};

/** @type {Transfer} */
const LINEAR = { decode: (c) => c, encode: (c) => c };

/** @type {Transfer} */
const A98_TRANSFER = {
  decode: symmetric((c) => Math.pow(c, 563 / 256)),
  encode: symmetric((c) => Math.pow(c, 256 / 563)),
};

/** @type {Transfer} */
const PROPHOTO_TRANSFER = {
  decode: symmetric((c) => (c <= 16 / 512 ? c / 16 : Math.pow(c, 1.8))),
  encode: symmetric((c) => (c >= 1 / 512 ? Math.pow(c, 1 / 1.8) : 16 * c)),
};

const REC2020_ALPHA = 1.09929682680944;
const REC2020_BETA = 0.018053968510807;

/** @type {Transfer} */
const REC2020_TRANSFER = {
  decode: symmetric((c) =>
    c < REC2020_BETA * 4.5 ? c / 4.5 : Math.pow((c + REC2020_ALPHA - 1) / REC2020_ALPHA, 1 / 0.45),
  ),
  encode: symmetric((c) =>
    c >= REC2020_BETA ? REC2020_ALPHA * Math.pow(c, 0.45) - (REC2020_ALPHA - 1) : 4.5 * c,
  ),
};

/**
 * The RGB-shaped spaces `color()` names: a transfer, the matrix from linear
 * light to XYZ, and whether that XYZ is relative to D50 rather than D65.
 * The two XYZ spaces are here too, with no transfer and no matrix.
 *
 * @type {Record<string, { transfer: Transfer, toXyz: Matrix | null, fromXyz: Matrix | null, d50: boolean }>}
 */
const RGB_SPACES = {
  srgb: rgbSpace(SRGB_TRANSFER, SRGB_TO_XYZ, false),
  "srgb-linear": rgbSpace(LINEAR, SRGB_TO_XYZ, false),
  "display-p3": rgbSpace(SRGB_TRANSFER, P3_TO_XYZ, false),
  "a98-rgb": rgbSpace(A98_TRANSFER, A98_TO_XYZ, false),
  "prophoto-rgb": rgbSpace(PROPHOTO_TRANSFER, PROPHOTO_TO_XYZ_D50, true),
  rec2020: rgbSpace(REC2020_TRANSFER, REC2020_TO_XYZ, false),
  xyz: { transfer: LINEAR, toXyz: null, fromXyz: null, d50: false },
  "xyz-d65": { transfer: LINEAR, toXyz: null, fromXyz: null, d50: false },
  "xyz-d50": { transfer: LINEAR, toXyz: null, fromXyz: null, d50: true },
};

/**
 * @param {Transfer} transfer
 * @param {Matrix} toXyz
 * @param {boolean} d50
 */
function rgbSpace(transfer, toXyz, d50) {
  return { transfer, toXyz, fromXyz: invert(toXyz), d50 };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Triple}
 */
function xyzToLinearSrgb(x, y, z) {
  return multiply(XYZ_TO_SRGB, x, y, z);
}

/**
 * @param {Triple} lab
 * @returns {Triple} XYZ, D50.
 */
function labToXyz([l, a, b]) {
  const f1 = (l + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const x = f0 ** 3 > LAB_EPSILON ? f0 ** 3 : (116 * f0 - 16) / LAB_KAPPA;
  const y = l > LAB_KAPPA * LAB_EPSILON ? f1 ** 3 : l / LAB_KAPPA;
  const z = f2 ** 3 > LAB_EPSILON ? f2 ** 3 : (116 * f2 - 16) / LAB_KAPPA;
  return [x * D50[0], y * D50[1], z * D50[2]];
}

/**
 * @param {Triple} xyz D50.
 * @returns {Triple}
 */
function xyzToLab([x, y, z]) {
  const f = (/** @type {number} */ v) =>
    v > LAB_EPSILON ? Math.cbrt(v) : (LAB_KAPPA * v + 16) / 116;
  const f0 = f(x / D50[0]);
  const f1 = f(y / D50[1]);
  const f2 = f(z / D50[2]);
  return [116 * f1 - 16, 500 * (f0 - f1), 200 * (f1 - f2)];
}

/**
 * @param {Triple} oklab
 * @returns {Triple} XYZ, D65.
 */
function oklabToXyz([l, a, b]) {
  const [p, q, r] = multiply(OKLAB_TO_LMS, l, a, b);
  return multiply(LMS_TO_XYZ, p ** 3, q ** 3, r ** 3);
}

/**
 * @param {Triple} xyz D65.
 * @returns {Triple}
 */
function xyzToOklab([x, y, z]) {
  const [p, q, r] = multiply(XYZ_TO_LMS, x, y, z);
  return multiply(LMS_TO_OKLAB, Math.cbrt(p), Math.cbrt(q), Math.cbrt(r));
}

/**
 * A polar space's coordinates from the rectangular ones under it. The hue is
 * `NaN` where the colour has none, a grey, which is what CSS calls a
 * powerless hue: interpolation takes the other end's.
 *
 * @param {number} l
 * @param {number} a
 * @param {number} b
 * @param {number} epsilon The chroma below which the hue is powerless.
 * @returns {Triple}
 */
function toPolar(l, a, b, epsilon) {
  const c = Math.hypot(a, b);
  const h = c < epsilon ? NaN : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return [l, c, h];
}

/**
 * @param {number} l
 * @param {number} c
 * @param {number} h Degrees; `NaN` reads as 0.
 * @returns {Triple}
 */
function fromPolar(l, c, h) {
  const radians = ((Number.isNaN(h) ? 0 : h) * Math.PI) / 180;
  return [l, c * Math.cos(radians), c * Math.sin(radians)];
}

/**
 * @param {number} h Degrees.
 * @param {number} s 0–1.
 * @param {number} l 0–1.
 * @returns {Triple} sRGB.
 */
function hslToSrgb(h, s, l) {
  const hue = (((Number.isNaN(h) ? 0 : h) % 360) + 360) % 360;
  const f = (/** @type {number} */ n) => {
    const k = (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/**
 * @param {Triple} rgb sRGB.
 * @returns {Triple} Hue in degrees (`NaN` for a grey), saturation and
 *   lightness 0–1.
 */
function srgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (min + max) / 2;
  const d = max - min;
  if (d === 0 || l <= 0 || l >= 1) {
    return [NaN, 0, l];
  }
  const s = (max - l) / Math.min(l, 1 - l);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/**
 * @param {number} h Degrees.
 * @param {number} w 0–1.
 * @param {number} b 0–1.
 * @returns {Triple} sRGB.
 */
function hwbToSrgb(h, w, b) {
  if (w + b >= 1) {
    const grey = w / (w + b);
    return [grey, grey, grey];
  }
  const [r, g, bl] = hslToSrgb(h, 1, 0.5);
  const scale = 1 - w - b;
  return [r * scale + w, g * scale + w, bl * scale + w];
}

/**
 * @param {Triple} rgb sRGB.
 * @returns {Triple}
 */
function srgbToHwb([r, g, b]) {
  const [h] = srgbToHsl([r, g, b]);
  const w = Math.min(r, g, b);
  const black = 1 - Math.max(r, g, b);
  return [w + black >= 1 ? NaN : h, w, black];
}

/**
 * Linear-light sRGB to sRGB, clipped into gamut.
 *
 * @param {Triple} linear
 * @returns {Triple}
 */
function encodeSrgb([r, g, b]) {
  return [
    clamp01(SRGB_TRANSFER.encode(r)),
    clamp01(SRGB_TRANSFER.encode(g)),
    clamp01(SRGB_TRANSFER.encode(b)),
  ];
}

/**
 * XYZ relative to one white or the other, to linear-light sRGB.
 *
 * @param {Triple} xyz
 * @param {boolean} d50
 * @returns {Triple}
 */
function xyzToSrgbLinear(xyz, d50) {
  const [x, y, z] = d50 ? multiply(D50_TO_D65, xyz[0], xyz[1], xyz[2]) : xyz;
  return xyzToLinearSrgb(x, y, z);
}

/**
 * @param {Triple} srgb
 * @param {boolean} d50
 * @returns {Triple}
 */
function srgbToXyz(srgb, d50) {
  const xyz = multiply(
    SRGB_TO_XYZ,
    SRGB_TRANSFER.decode(srgb[0]),
    SRGB_TRANSFER.decode(srgb[1]),
    SRGB_TRANSFER.decode(srgb[2]),
  );
  return d50 ? multiply(D65_TO_D50, xyz[0], xyz[1], xyz[2]) : xyz;
}

/**
 * Which coordinate of a polar space is its hue.
 *
 * @type {Partial<Record<ColorSpace, number>>}
 */
export const HUE_INDEX = { hsl: 0, hwb: 0, lch: 2, oklch: 2 };

/**
 * Every space `in <space>` can name, with `xyz` already read as the
 * `xyz-d65` it means.
 *
 * @type {ReadonlySet<string>}
 */
export const COLOR_SPACES = new Set([
  "srgb",
  "srgb-linear",
  "display-p3",
  "a98-rgb",
  "prophoto-rgb",
  "rec2020",
  "lab",
  "oklab",
  "xyz-d50",
  "xyz-d65",
  "hsl",
  "hwb",
  "lch",
  "oklch",
]);

/**
 * An sRGB colour's coordinates in another space, for interpolating there.
 * A polar space's hue is in degrees, `NaN` where the colour has none; hsl
 * and hwb take their percentages as 0–1.
 *
 * @param {Triple} srgb
 * @param {ColorSpace} space
 * @returns {Triple}
 */
export function srgbTo(srgb, space) {
  switch (space) {
    case "srgb":
      return [srgb[0], srgb[1], srgb[2]];
    case "hsl":
      return srgbToHsl(srgb);
    case "hwb":
      return srgbToHwb(srgb);
    case "lab":
      return xyzToLab(srgbToXyz(srgb, true));
    case "lch": {
      const [l, a, b] = xyzToLab(srgbToXyz(srgb, true));
      return toPolar(l, a, b, 0.0015);
    }
    case "oklab":
      return xyzToOklab(srgbToXyz(srgb, false));
    case "oklch": {
      const [l, a, b] = xyzToOklab(srgbToXyz(srgb, false));
      return toPolar(l, a, b, 0.000004);
    }
    default: {
      const target = RGB_SPACES[space];
      const xyz = srgbToXyz(srgb, target.d50);
      const linear = target.fromXyz ? multiply(target.fromXyz, xyz[0], xyz[1], xyz[2]) : xyz;
      return [
        target.transfer.encode(linear[0]),
        target.transfer.encode(linear[1]),
        target.transfer.encode(linear[2]),
      ];
    }
  }
}

/**
 * The inverse of `srgbTo`: coordinates in a space, as sRGB clipped into
 * gamut.
 *
 * @param {Triple} coords
 * @param {ColorSpace} space
 * @returns {Triple}
 */
export function toSrgb(coords, space) {
  switch (space) {
    case "srgb":
      return [clamp01(coords[0]), clamp01(coords[1]), clamp01(coords[2])];
    case "hsl":
      return clampTriple(hslToSrgb(coords[0], coords[1], coords[2]));
    case "hwb":
      return clampTriple(hwbToSrgb(coords[0], coords[1], coords[2]));
    case "lab":
      return encodeSrgb(xyzToSrgbLinear(labToXyz(coords), true));
    case "lch":
      return encodeSrgb(xyzToSrgbLinear(labToXyz(fromPolar(...coords)), true));
    case "oklab":
      return encodeSrgb(xyzToSrgbLinear(oklabToXyz(coords), false));
    case "oklch":
      return encodeSrgb(xyzToSrgbLinear(oklabToXyz(fromPolar(...coords)), false));
    default: {
      const source = RGB_SPACES[space];
      const linear = /** @type {Triple} */ (coords.map(source.transfer.decode));
      const xyz = source.toXyz ? multiply(source.toXyz, linear[0], linear[1], linear[2]) : linear;
      return encodeSrgb(xyzToSrgbLinear(xyz, source.d50));
    }
  }
}

/**
 * @param {number} x
 * @returns {number}
 */
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * @param {Triple} triple
 * @returns {Triple}
 */
function clampTriple([a, b, c]) {
  return [clamp01(a), clamp01(b), clamp01(c)];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The keywords a computed style can still hold as words. Browsers compute
 * names to `rgb()`; jsdom keeps the ones authored, and these are the ones
 * the packages and their tests write.
 *
 * @type {Record<string, RGBA>}
 */
const NAMED_COLORS = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [1, 1, 1, 1],
  red: [1, 0, 0, 1],
  lime: [0, 1, 0, 1],
  blue: [0, 0, 1, 1],
};

/**
 * The functions whose colours are written in legacy syntax. A gradient
 * whose stops are all legacy interpolates in sRGB by default; one with any
 * other stop interpolates in Oklab.
 */
const LEGACY_FUNCTION = /^(?:rgba?|hsla?|hwb)\(/;

/**
 * Whether a colour is written in a legacy syntax: hex, a name, `rgb()`,
 * `hsl()` or `hwb()`.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isLegacyColor(value) {
  const text = value.trim().toLowerCase();
  return text.startsWith("#") || /^[a-z]+$/.test(text) || LEGACY_FUNCTION.test(text);
}

/**
 * A number, a percentage of `percentScale`, or `none`, which reads as 0.
 *
 * @param {string} token
 * @param {number} percentScale What 100% stands for.
 * @returns {number}
 */
function component(token, percentScale) {
  if (token === "none") {
    return 0;
  }
  if (token.endsWith("%")) {
    return (Number(token.slice(0, -1)) / 100) * percentScale;
  }
  return token === "" ? NaN : Number(token);
}

/**
 * A hue in degrees: a bare number, or an angle with its unit.
 *
 * @param {string} token
 * @returns {number}
 */
function hue(token) {
  if (token === "none") {
    return 0;
  }
  const match = /^(-?[\d.e+-]+)(deg|rad|grad|turn)?$/.exec(token);
  if (!match) {
    return NaN;
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case "rad":
      return (value * 180) / Math.PI;
    case "grad":
      return value * 0.9;
    case "turn":
      return value * 360;
    default:
      return value;
  }
}

/**
 * The parts of a colour function's arguments: three channels and an alpha,
 * in either syntax — `rgb(1, 2, 3, 0.5)` and `rgb(1 2 3 / 50%)`.
 *
 * @param {string} args
 * @returns {{ channels: string[], alpha: number } | null}
 */
function splitArguments(args) {
  const slash = args.indexOf("/");
  const channelText = slash < 0 ? args : args.slice(0, slash);
  const channels = channelText.split(/[\s,]+/).filter((part) => part.length > 0);
  let alphaText = slash < 0 ? undefined : args.slice(slash + 1).trim();
  if (alphaText === undefined && channels.length === 4 && args.includes(",")) {
    alphaText = channels.pop();
  }
  const alpha = alphaText === undefined ? 1 : component(alphaText, 1);
  if (!Number.isFinite(alpha)) {
    return null;
  }
  return { channels, alpha: clamp01(alpha) };
}

/**
 * A colour as a computed style holds it, as sRGB channels and an alpha, or
 * `null` for a string that is not a colour this reads.
 *
 * @param {string} value
 * @param {string} [currentColor] What `currentcolor` stands for.
 * @returns {RGBA | null}
 */
export function parseCssColor(value, currentColor) {
  const text = value.trim().toLowerCase();
  if (text === "currentcolor") {
    return currentColor && currentColor.trim().toLowerCase() !== "currentcolor"
      ? parseCssColor(currentColor)
      : null;
  }
  if (text in NAMED_COLORS) {
    return /** @type {RGBA} */ ([...NAMED_COLORS[text]]);
  }
  if (text.startsWith("#")) {
    return parseHex(text.slice(1));
  }
  const open = text.indexOf("(");
  if (open < 0 || !text.endsWith(")")) {
    return null;
  }
  const name = text.slice(0, open);
  const parts = splitArguments(text.slice(open + 1, -1));
  if (!parts) {
    return null;
  }
  const rgb = channelsOf(name, parts.channels);
  if (!rgb || rgb.some((channel) => !Number.isFinite(channel))) {
    return null;
  }
  return [rgb[0], rgb[1], rgb[2], parts.alpha];
}

/**
 * @param {string} hex
 * @returns {RGBA | null}
 */
function parseHex(hex) {
  if (!/^[0-9a-f]+$/.test(hex)) {
    return null;
  }
  const digits =
    hex.length === 3 || hex.length === 4
      ? hex.split("").map((digit) => parseInt(digit + digit, 16))
      : hex.length === 6 || hex.length === 8
        ? (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16))
        : null;
  if (!digits) {
    return null;
  }
  return [digits[0] / 255, digits[1] / 255, digits[2] / 255, (digits[3] ?? 255) / 255];
}

/**
 * The sRGB channels of a colour function, clipped into gamut.
 *
 * @param {string} name
 * @param {string[]} channels
 * @returns {Triple | null}
 */
function channelsOf(name, channels) {
  if (name === "color") {
    const [space, ...values] = channels;
    const source = RGB_SPACES[space];
    if (!source || values.length !== 3) {
      return null;
    }
    const coords = /** @type {Triple} */ (values.map((token) => component(token, 1)));
    return toSrgb(coords, space === "xyz" ? "xyz-d65" : /** @type {ColorSpace} */ (space));
  }
  if (channels.length !== 3) {
    return null;
  }
  const [x, y, z] = channels;
  switch (name) {
    case "rgb":
    case "rgba":
      return clampTriple([
        component(x, 255) / 255,
        component(y, 255) / 255,
        component(z, 255) / 255,
      ]);
    case "hsl":
    case "hsla":
      return toSrgb([hue(x), component(y, 100) / 100, component(z, 100) / 100], "hsl");
    case "hwb":
      return toSrgb([hue(x), component(y, 100) / 100, component(z, 100) / 100], "hwb");
    case "lab":
      return toSrgb([component(x, 100), component(y, 125), component(z, 125)], "lab");
    case "lch":
      return toSrgb([component(x, 100), component(y, 150), hue(z)], "lch");
    case "oklab":
      return toSrgb([component(x, 1), component(y, 0.4), component(z, 0.4)], "oklab");
    case "oklch":
      return toSrgb([component(x, 1), component(y, 0.4), hue(z)], "oklch");
    default:
      return null;
  }
}
