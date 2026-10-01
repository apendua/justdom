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
 * @property {THREE.Texture | null} texture Kept beside the signal so that
 *   letting go of the last user can dispose it without a reactive read from
 *   inside a cleanup.
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
 * icon decodes and uploads it once. Entries are refcounted rather than kept
 * forever: a panel that has finished with an image has finished with the
 * VRAM too, and an unbounded cache in a headset is a leak with a nicer name.
 *
 * @type {Map<string, ImageEntry>}
 */
const entries = new Map();

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
  const entry = withChannel(null, () => ({ state: Signal.of(PENDING), users: 0, texture: null }));
  entries.set(url, entry);
  loader.load(
    url,
    (texture) => {
      if (entries.get(url) !== entry) {
        // Everyone who asked for this let go while it was in flight. The
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
      const image = /** @type {{ width?: number, height?: number } | null} */ (texture.image);
      entry.texture = texture;
      entry.state.set({
        status: "loaded",
        texture,
        width: image?.width ?? 0,
        height: image?.height ?? 0,
      });
    },
    undefined,
    () => {
      if (entries.get(url) !== entry) {
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
 * Take a share in the texture for a URL, loading it if this is the first
 * asker.
 *
 * @param {string} url
 * @returns {ImageEntry}
 */
export function acquireImage(url) {
  const entry = entryFor(url);
  entry.users += 1;
  return entry;
}

/**
 * Give it back. The last one out disposes the texture and forgets the URL, so
 * asking again reloads it — which is the right trade for a panel that has
 * been taken down, and a small cost for one that is churning through the same
 * few images.
 *
 * @param {string} url
 * @returns {void}
 */
export function releaseImage(url) {
  const entry = entries.get(url);
  if (!entry) {
    return;
  }
  entry.users -= 1;
  if (entry.users > 0) {
    return;
  }
  entries.delete(url);
  entry.texture?.dispose();
  entry.texture = null;
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
 * `getOwnClipBox` makes, and for the same reason: a browser resolves every
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
 *    does, because a release followed by an acquire of the same URL would
 *    dispose the texture and fetch it again;
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
