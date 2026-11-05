import * as THREE from "three";

/**
 * The texture cache's loader, stood in for: what the image suites and the
 * SVG pattern suites load through, since jsdom decodes no pictures.
 */

/**
 * The picture a stubbed loader hands back.
 *
 * `@types/three` 0.185 made `Texture` generic over its image and declared
 * `TextureLoader` to produce a `Texture<HTMLImageElement>`, so a stand-in has
 * to claim to be an element to be handed to one. This is that claim, made
 * once and in the open: the fitting maths reads a width and a height and
 * nothing else, which is all there is here.
 *
 * @param {number} width
 * @param {number} height
 */
export function fakeTexture(width, height) {
  return new THREE.Texture(/** @type {HTMLImageElement} */ ({ width, height }));
}

/**
 * A loader that answers only when told to, and counts what it was asked
 * for. Restore it when done.
 */
export function deferredLoader() {
  const original = THREE.TextureLoader.prototype.load;
  /** @type {{ url: string, land: (width: number, height: number) => { texture: THREE.Texture, disposed: () => number }, fail: () => void }[]} */
  const loads = [];
  THREE.TextureLoader.prototype.load = function (url, onLoad, _onProgress, onError) {
    loads.push({
      url,
      land: (width, height) => {
        const texture = fakeTexture(width, height);
        // Counted from before it lands, since landing can dispose it.
        const disposed = disposals(texture);
        onLoad?.(/** @type {THREE.Texture<HTMLImageElement>} */ (texture));
        return { texture, disposed };
      },
      fail: () => onError?.(new Error("404")),
    });
    return /** @type {THREE.Texture<HTMLImageElement>} */ (new THREE.Texture());
  };
  return {
    loads,
    restore: () => {
      THREE.TextureLoader.prototype.load = original;
    },
  };
}

/** @param {THREE.Texture} texture */
function disposals(texture) {
  let count = 0;
  texture.addEventListener("dispose", () => {
    count += 1;
  });
  return () => count;
}
