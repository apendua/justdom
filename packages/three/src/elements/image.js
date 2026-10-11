import * as THREE from "three";
import { addDependency, Derived, fromEvent, onCleanup, Signal, withChannel } from "@apendua/signal";
import { getComputedStyleCached } from "./mirror.js";
import { fitImage } from "./objectFit.js";

/**
 * @import VisualProperties from './VisualProperties.js';
 * @import {Size} from './objectFit.js';
 */

/**
 * The picture an element paints inside its own box.
 *
 * An `<img>` in a portal is an ordinary CSS box that happens to have a
 * bitmap in it: it has a background, a border, corner radii and a place in
 * the clip chain like anything else, and the image is one more layer painted
 * between the background and the descendants — which is exactly where CSS
 * paints replaced content. So the box the element already draws is where the
 * image goes, as a texture on the same quad, rather than a second mesh with a
 * second set of rounded corners to keep in step. A photograph in a circular
 * avatar is then the same distance field that rounds the border, and an
 * image scrolled half out of a list is trimmed by the same clip box.
 *
 * What this module owns is the part the box does not know about: turning a
 * `src` into a texture, keeping one texture per URL however many elements
 * point at it, and working out where in the content box the picture lands.
 * The last of those is `objectFit.js`, which is pure arithmetic; this file is
 * the DOM and three.js around it.
 */

/**
 * A loaded texture and the intrinsic size that came with it. The size is read
 * off the decoded image rather than off the `<img>`, so it is available to
 * anything that has a URL — `background-image`, when its turn comes — and not
 * only to elements the browser is laying out.
 *
 * @typedef {object} ImageState
 * @property {"loading" | "loaded" | "error"} status
 * @property {THREE.Texture | null} texture
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} ImageEntry
 * @property {Signal<ImageState>} state
 * @property {number} users How many elements are pointing at this URL.
 */

/**
 * The region of an element its content is painted in, in the element's own
 * px, y down, origin at the top-left corner of the border box.
 *
 * @typedef {object} ContentBox
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * Everything the shader needs to paint one element's picture: which texture,
 * where it goes, and what confines it.
 *
 * @typedef {object} ContentImage
 * @property {THREE.Texture} texture
 * @property {number} opacity
 * @property {number} left Where the image itself is drawn — which is allowed
 *   to be outside the content box, and under `cover` or `none` usually is.
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 * @property {ContentBox} content What clips it.
 */

/**
 * Textures are shared by URL, so a list of a hundred rows wearing the same
 * icon decodes and uploads it once. Entries are refcounted, and an entry
 * whose last user lets go is kept idle rather than disposed, so a picture
 * that comes back (an icon swapped by a hover rule, a row remounted, a game
 * dealt again) is drawn at once and not loaded again. An unbounded cache in
 * a headset is a leak with a nicer name, so the idle entries are held to
 * `IDLE_BUDGET` bytes.
 *
 * Each entry is in one of five states, and these are all the moves:
 *
 * - **loading**, with users: becomes loaded when its picture lands, failed
 *   when the load fails, and idle when its last user lets go;
 * - **loaded**, with users: becomes idle when its last user lets go;
 * - **failed**, with users: becomes gone when its last user lets go, so
 *   asking for the URL again tries again;
 * - **idle**, with no users, its picture kept or still on its way: becomes
 *   loaded or loading again when it is acquired. It becomes gone when its
 *   load fails, when its picture alone is bigger than `IDLE_BUDGET`, when
 *   the budget evicts it, or when `releaseIdleImages` is called. The budget
 *   evicts the oldest idle pictures first, and never one still on its way,
 *   which weighs nothing and would only throw its fetch away. A picture
 *   that lands while idle moves to the back of the line as the newest, so
 *   it is never evicted by its own arrival;
 * - **gone**: its texture disposed, or disposed as it lands. Acquiring the
 *   URL again starts a new entry, loading.
 *
 * @type {Map<string, ImageEntry>}
 */
const entries = new Map();

/**
 * The entries nobody is using, oldest first: a `Map` keeps insertion order,
 * and an entry is deleted and inserted again each time it goes idle, and
 * when its picture lands while it is idle.
 *
 * @type {Map<string, ImageEntry>}
 */
const idle = new Map();

/**
 * What the idle entries weigh between them, kept current so that a release
 * does not add up the whole idle list. It goes up when an entry goes idle
 * and when an idle entry's picture lands, and down in `leaveIdle`.
 */
let idleBytes = 0;

/**
 * How many bytes of pictures the idle entries may hold between them: 16 MiB,
 * a 2048 by 2048 picture or 1,024 icons of 64 by 64. It counts each
 * picture's base level. Its mipmaps, which three generates by default, add
 * about a third on the GPU.
 */
export const IDLE_BUDGET = 16 * 1024 * 1024;

/**
 * What an entry's picture weighs, at four bytes a pixel. Nothing for one
 * still loading or failed. Read with `peek`, since a release runs inside a
 * cleanup, where a tracked read would make the computation being torn down
 * depend on the entry.
 *
 * @param {ImageEntry} entry
 * @returns {number}
 */
function bytesOf(entry) {
  const { texture, width, height } = entry.state.peek();
  return texture ? width * height * 4 : 0;
}

/**
 * Take an entry off the idle list, if it is on it.
 *
 * @param {string} url
 * @param {ImageEntry} entry
 */
function leaveIdle(url, entry) {
  if (idle.delete(url)) {
    idleBytes -= bytesOf(entry);
  }
}

/**
 * Forget an entry and dispose its texture. One still loading has none yet,
 * and the load callback disposes the texture when it lands, since the URL no
 * longer maps to this entry.
 *
 * @param {string} url
 * @param {ImageEntry} entry
 */
function forget(url, entry) {
  leaveIdle(url, entry);
  entries.delete(url);
  entry.state.peek().texture?.dispose();
}

/**
 * Fit the idle list in `IDLE_BUDGET` now that `entry` weighs what it does on
 * it: forget `entry` alone if it is bigger than the whole budget, and
 * otherwise the oldest idle pictures, skipping any still on its way, until
 * the rest fit.
 *
 * @param {string} url
 * @param {ImageEntry} entry
 */
function fitIdle(url, entry) {
  if (bytesOf(entry) > IDLE_BUDGET) {
    forget(url, entry);
    return;
  }
  for (const [oldest, candidate] of idle) {
    if (idleBytes <= IDLE_BUDGET) {
      return;
    }
    if (bytesOf(candidate) > 0) {
      forget(oldest, candidate);
    }
  }
}

/**
 * `TextureLoader` fetches the URL itself rather than reusing the `<img>` the
 * portal already has in the document. The browser's cache makes that a second
 * hit and not a second download, and what it buys is independence: nothing
 * here needs an element, so the same path serves `background-image` and any
 * other URL a style names. It also keeps three's texture off a live DOM node
 * whose `src` the page is free to change underneath it.
 *
 * The default `crossOrigin` is `anonymous`, which is what makes a
 * cross-origin image usable as a texture at all.
 */
const loader = new THREE.TextureLoader();

/** @type {ImageState} */
const PENDING = { status: "loading", texture: null, width: 0, height: 0 };

/** @type {ImageState} */
const FAILED = { status: "error", texture: null, width: 0, height: 0 };

/**
 * A URL whose picture is an SVG: a path ending in `.svg` or `.svgz`, before
 * any query or fragment, or an SVG data URL.
 */
const SVG_URL = /^data:image\/svg\+xml[;,]|\.svgz?(?:[?#]|$)/i;

/**
 * The size an SVG is drawn at when the browser reports none, the default
 * size CSS gives a replaced element that has none of its own. Firefox has
 * reported 0 by 0 for an SVG with only a `viewBox`, and the picture handed
 * back as it came is the one Chrome refuses.
 */
const DEFAULT_SVG_SIZE = { width: 300, height: 150 };

/**
 * What to upload for a decoded picture: the picture itself, or for an SVG a
 * canvas it is drawn on at its natural size.
 *
 * Chrome on a laptop refuses to upload an SVG that has no size of its own,
 * one with a `viewBox` and no `width` or `height`, as a texture
 * ("texSubImage2D: bad image data"), so the card that holds it shows no
 * picture in a session while the page shows it. It draws the same SVG on a
 * canvas at the size it gives it, and a canvas uploads.
 *
 * The draw happens once per URL, as the load lands, never per frame. It
 * costs a few times what the upload costs, about 3 ms in place of 1 ms for a
 * 256 by 208 picture and 34 ms in place of 8 ms at 1024 by 832, measured in
 * Chromium on SwiftShader, and the canvas, 4 bytes a pixel, is kept as the
 * texture's image in place of the decoded picture. Only an SVG pays it.
 *
 * @param {string} url
 * @param {HTMLImageElement} image
 * @returns {HTMLImageElement | HTMLCanvasElement}
 */
function uploadable(url, image) {
  if (!SVG_URL.test(url)) {
    return image;
  }
  const sized = image.naturalWidth > 0 && image.naturalHeight > 0;
  const width = sized ? image.naturalWidth : DEFAULT_SVG_SIZE.width;
  const height = sized ? image.naturalHeight : DEFAULT_SVG_SIZE.height;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return image;
  }
  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

/**
 * @param {string} url
 * @returns {ImageEntry}
 */
function entryFor(url) {
  const existing = entries.get(url);
  if (existing) {
    return existing;
  }
  // The entry is shared by every panel that names this URL, so it belongs to
  // none of them — and it is built lazily, during whichever panel's flush
  // asked first, with that panel's channel ambient. A plain `Signal` happens
  // not to capture the ambient channel today, so this wrap changes nothing
  // yet; it is here because the rule for shared state is not conditional on
  // that: anything panels share is constructed in the default channel, so
  // that no future reactive machinery in an entry can end up owned by a
  // panel that may be disposed while the load is still in flight.
  /** @type {ImageEntry} */
  const entry = withChannel(null, () => ({ state: Signal.of(PENDING), users: 0 }));
  entries.set(url, entry);
  loader.load(
    url,
    (texture) => {
      if (entries.get(url) !== entry) {
        // `releaseIdleImages` forgot the entry while it was in flight. The
        // texture was never uploaded and nothing is pointing at it.
        texture.dispose();
        return;
      }
      // sRGB is what a PNG or a JPEG holds, and saying so is what gets it
      // decoded — three picks an sRGB internal format, so the sampler hands
      // the shader linear values and the picture is not washed out.
      texture.colorSpace = THREE.SRGBColorSpace;
      // The quad samples a rectangle of its own choosing and never wraps;
      // clamping is what lets the shader clamp UVs instead of branching.
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      // Three types the loader's texture as holding an `<img>`; from here
      // on it holds whatever `uploadable` gives it.
      /** @type {THREE.Texture<HTMLImageElement | HTMLCanvasElement>} */ (texture).image =
        uploadable(url, texture.image);
      const image = /** @type {{ width?: number, height?: number } | null} */ (texture.image);
      entry.state.set({
        status: "loaded",
        texture,
        width: image?.width ?? 0,
        height: image?.height ?? 0,
      });
      if (idle.has(url)) {
        // Everyone let go while it was in flight. It lands idle, now weighs
        // something, and moves to the back of the line as the newest.
        idle.delete(url);
        idle.set(url, entry);
        idleBytes += bytesOf(entry);
        fitIdle(url, entry);
      }
    },
    undefined,
    () => {
      if (entries.get(url) !== entry) {
        return;
      }
      if (idle.has(url)) {
        // Nobody is waiting for it, and a failure is not worth keeping.
        forget(url, entry);
        return;
      }
      // A broken image draws nothing at all — no alt text, no placeholder
      // frame. The element's own box, border and background are still there,
      // which is the same thing a page shows for an image that failed with no
      // `alt` worth rendering.
      entry.state.set(FAILED);
    },
  );
  return entry;
}

/**
 * Take a share in the texture for a URL, loading it if no entry has it,
 * loaded or idle.
 *
 * @param {string} url
 * @returns {ImageEntry}
 */
export function acquireImage(url) {
  const entry = entryFor(url);
  leaveIdle(url, entry);
  entry.users += 1;
  return entry;
}

/**
 * Give it back. The last one out leaves the entry idle, its texture kept for
 * whoever asks next, unless its picture failed, which is forgotten so that
 * asking again tries again.
 *
 * @param {string} url
 * @returns {void}
 */
export function releaseImage(url) {
  const entry = entries.get(url);
  if (!entry || entry.users === 0) {
    return;
  }
  entry.users -= 1;
  if (entry.users > 0) {
    return;
  }
  if (entry.state.peek().status === "error") {
    forget(url, entry);
    return;
  }
  idle.set(url, entry);
  idleBytes += bytesOf(entry);
  fitIdle(url, entry);
}

/**
 * Dispose every idle entry's texture, to free memory as a renderer goes.
 * The cache is shared, so this also drops pictures another live `render()`
 * could have reused, which would load them again.
 *
 * @returns {void}
 */
export function releaseIdleImages() {
  for (const [url, entry] of idle) {
    forget(url, entry);
  }
}

/**
 * Whether this element is one that carries a picture of its own. A tag never
 * changes, so callers may read this once and build (or not build) the image
 * machinery accordingly.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isImageElement(element) {
  return element.tagName.toLowerCase() === "img";
}

/**
 * The URL an `<img>` is currently showing.
 *
 * The portal observes a `src` write like any attribute, but the write comes
 * before the picture does: an image announces its own arrival, and a `src`
 * swap announces itself the same way a moment later. Both events are
 * dependencies here, so this is re-read when either fires and `currentSrc` —
 * which is what a `srcset` actually resolved to — has settled.
 *
 * @param {HTMLElement} element
 * @returns {string | null}
 */
export function getImageSource(element) {
  addDependency(fromEvent(element, "load"));
  addDependency(fromEvent(element, "error"));
  const image = /** @type {HTMLImageElement} */ (element);
  return image.currentSrc || image.src || null;
}

/**
 * @param {string} value
 * @returns {number}
 */
function pixels(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The box an element paints its content in: the border box less its borders
 * and its padding.
 *
 * The insets are read straight off the computed style in px rather than
 * through `VisualProperties`' unit-aware getters — the same choice
 * `getOwnClipWindow` makes, and for the same reason: a browser resolves every
 * padding and border to px before a computed style is handed over, so the
 * unit machinery buys nothing here. It also costs something. Resolving `ex`
 * means measuring the font, which cannot be answered until the fonts have
 * loaded, and a second reader joining that half-answered chain at an
 * arbitrary moment — which is exactly what a picture arriving is — is a race
 * nobody needs to run.
 *
 * @param {HTMLElement} element
 * @param {VisualProperties} properties
 * @returns {ContentBox}
 */
export function getContentBox(element, properties) {
  const style = getComputedStyleCached(element);
  const left = pixels(style.borderLeftWidth) + pixels(style.paddingLeft);
  const top = pixels(style.borderTopWidth) + pixels(style.paddingTop);
  const right = properties.totalWidth - pixels(style.borderRightWidth) - pixels(style.paddingRight);
  const bottom =
    properties.totalHeight - pixels(style.borderBottomWidth) - pixels(style.paddingBottom);
  // Padding and borders that add up to more than the element is wide leave no
  // content box at all rather than an inside-out one.
  return { left, top, right: Math.max(right, left), bottom: Math.max(bottom, top) };
}

/**
 * Where a loaded picture goes inside an element, as the shader wants it: both
 * rectangles in the element's own px.
 *
 * @param {ContentBox} content
 * @param {string} fit Computed `object-fit`.
 * @param {string} position Computed `object-position`.
 * @param {Size} natural The image's intrinsic size.
 * @param {THREE.Texture} texture
 * @param {number} opacity
 * @returns {ContentImage}
 */
export function placeContentImage(content, fit, position, natural, texture, opacity) {
  const rect = fitImage(
    fit,
    position,
    { width: content.right - content.left, height: content.bottom - content.top },
    natural,
  );
  return {
    texture,
    opacity,
    left: content.left + rect.x,
    top: content.top + rect.y,
    right: content.left + rect.x + rect.width,
    bottom: content.top + rect.y + rect.height,
    content,
  };
}

/**
 * @param {ContentImage | null} a
 * @param {ContentImage | null} b
 * @returns {boolean}
 */
function contentImageEqual(a, b) {
  if (!a || !b) {
    return a === b;
  }
  return (
    a.texture === b.texture &&
    a.opacity === b.opacity &&
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.content.left === b.content.left &&
    a.content.top === b.content.top &&
    a.content.right === b.content.right &&
    a.content.bottom === b.content.bottom
  );
}

/**
 * The picture this element is showing, as a signal — null until there is one,
 * and null again if it never arrives.
 *
 * Three computations rather than one, and the split is the point:
 *
 *  - the URL, so that an image announcing its own load does not look like a
 *    new source. `load` fires with `currentSrc` reading exactly what `src`
 *    already said, and string equality stops there;
 *  - the share in the texture, so that a load — or a resize, or a restyle —
 *    is never a reason to let go of it. Ownership changes only when the URL
 *    does, because a release followed by an acquire of the same URL sends
 *    the entry through the idle list, where a full budget could dispose it
 *    and the acquire would fetch it again;
 *  - the placement, which reads the layout and the style and re-runs as often
 *    as either moves. Its equality is by value, so an animation that leaves
 *    the picture where it was writes no uniforms.
 *
 * @param {HTMLElement} element
 * @param {VisualProperties} properties
 * @returns {Derived<ContentImage | null>}
 */
export function contentImage(element, properties) {
  const source = new Derived(() => getImageSource(element));

  const owned = new Derived(() => {
    const url = source.get();
    if (!url) {
      return null;
    }
    const entry = acquireImage(url);
    onCleanup(() => releaseImage(url));
    return entry;
  });

  return new Derived(
    () => {
      const entry = owned.get();
      if (!entry) {
        return null;
      }
      const state = entry.state.get();
      if (!state.texture) {
        return null;
      }
      const style = getComputedStyleCached(element);
      return placeContentImage(
        getContentBox(element, properties),
        style.objectFit || "fill",
        style.objectPosition || "50% 50%",
        { width: state.width, height: state.height },
        state.texture,
        properties.opacity,
      );
    },
    { isEqual: contentImageEqual },
  );
}
