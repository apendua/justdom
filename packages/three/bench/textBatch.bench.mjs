/**
 * What a change to one label costs the text batch, in the two things the
 * array texture makes it pay: bytes on their way to the GPU, and array
 * textures allocated.
 *
 *   node --import ./src/test/setup-jsdom.js bench/textBatch.bench.mjs
 *
 * Written for one question. A size class used to rewrite the changed run's
 * layer of an array it already had and ask three to upload that layer alone;
 * it now rebuilds the array from its mirror and lets the whole thing go up,
 * because a Quest's driver does not regenerate the mip chain of an array
 * whose storage already existed and the label then blended into its own
 * previous value with distance. This measures what that cost.
 *
 * **The mip chain is not the difference, and that is worth saying first.**
 * Three regenerates mipmaps in `uploadTexture`, after whichever upload branch
 * it took, and for a `TEXTURE_2D_ARRAY` that call covers every layer of the
 * array. It did so for a one-layer update too -- the old code said as much in
 * its own comment. So both strategies regenerate the same mips just as often.
 * What changed is the upload underneath them, and the texture object.
 *
 * The numbers below are counted, not timed, wherever counting is possible:
 * under jsdom there is no GL, so bytes and allocations are the portable
 * signal and the wall clock only says that the JS side is not where the cost
 * is. The upload volume is read the way the renderer decides it
 * (`WebGLTextures.uploadTexture`): a texture three has not seen before
 * allocates its storage and uploads in full, and one it has seen uploads the
 * layers in `layerUpdates` and no others.
 */
import * as THREE from "three";
import { place } from "../src/elements/place.js";
import { paintBatch } from "../src/test/textRuns.js";

/**
 * A rasterized run, as the batch reads one: a mask in the material's alpha
 * map, and a quad whose position attribute carries the run's size.
 *
 * Unlike the test's stand-in this one hands back a context, so the pixel copy
 * in `SizeClass.write` really runs -- it is the one part of the change that
 * does work per byte on the CPU.
 */
function canvasOf(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.fill(0x80);
  return /** @type {HTMLCanvasElement} */ (
    /** @type {unknown} */ ({
      width,
      height,
      getContext: () => ({ getImageData: () => ({ data: pixels }) }),
    })
  );
}

function run(width, height) {
  const material = new THREE.MeshBasicMaterial({
    alphaMap: new THREE.Texture(canvasOf(width, height)),
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, width, 0, 0, 0, height, 0, width, height, 0]),
      3,
    ),
  );
  const mesh = new THREE.Mesh(geometry, material);
  place(mesh, 0, 0, 0);
  return mesh;
}

/**
 * A label whose text changed: the mirror rasterizes to a new canvas and hangs
 * a new texture on the material, which is exactly what the batch watches for.
 */
function retext(mesh, width, height) {
  const material = /** @type {THREE.MeshBasicMaterial} */ (mesh.material);
  material.alphaMap = new THREE.Texture(canvasOf(width, height));
}

function panel(count, width, height) {
  const container = new THREE.Group();
  place(container, 0, 0, 0);
  const draws = paintBatch(container);
  const batch = draws.runs;
  const meshes = [];
  for (let i = 0; i < count; i++) {
    const mesh = run(width, height);
    container.add(mesh);
    batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
    meshes.push(mesh);
  }
  return { container, draws, meshes };
}

/** Every array texture a draw of this panel is currently sampling. */
function arraysOf(container) {
  const found = new Set();
  for (const child of container.children) {
    const mesh = /** @type {THREE.InstancedMesh} */ (child);
    for (const texture of (mesh.isInstancedMesh && mesh.material.uniforms?.uRuns?.value) || []) {
      if (texture) {
        found.add(texture);
      }
    }
  }
  return found;
}

/**
 * What the renderer would send for the flush just taken, by the rule in
 * `WebGLTextures.uploadTexture`: an array it has never seen goes up whole,
 * and one it has goes up by the layers named in `layerUpdates`.
 *
 * @param {Set<THREE.DataArrayTexture>} arrays
 * @param {WeakSet<THREE.DataArrayTexture>} seen
 * @param {WeakMap<THREE.DataArrayTexture, number>} versions
 */
function uploadedBytes(arrays, seen, versions) {
  let bytes = 0;
  let fresh = 0;
  for (const texture of arrays) {
    const { width, height, depth } = texture.image;
    const layerBytes = width * height * 4;
    if (!seen.has(texture)) {
      // Storage three has never allocated: texStorage3D, then the whole array.
      seen.add(texture);
      versions.set(texture, texture.version);
      bytes += layerBytes * depth;
      fresh += 1;
      continue;
    }
    if (texture.version === versions.get(texture)) {
      continue;
    }
    versions.set(texture, texture.version);
    bytes +=
      texture.layerUpdates.size > 0 ? layerBytes * texture.layerUpdates.size : layerBytes * depth;
    // Standing in for the renderer, which clears the set once it has sent
    // those layers. Without this the requests pile up and a flush is charged
    // for every layer ever touched -- which flatters neither strategy, but
    // does hide the one that uploads a layer at a time.
    texture.clearLayerUpdates();
  }
  return { bytes, fresh };
}

const KB = (bytes) => `${(bytes / 1024).toFixed(0)} kB`;

/**
 * One panel, driven `flushes` times. `perFlush` labels are re-texted before
 * each flush: one is a readout ticking or a button being pressed, and all of
 * them is a list re-rendering, which is the case the two strategies were
 * always going to agree on.
 */
function measure(label, count, width, height, perFlush, flushes = 50) {
  const { container, draws, meshes } = panel(count, width, height);
  const seen = new WeakSet();
  const versions = new WeakMap();

  draws.invalidate();
  draws.flush();
  const mounting = uploadedBytes(arraysOf(container), seen, versions).bytes;

  const startedAt = performance.now();
  let bytes = 0;
  let fresh = 0;
  let next = 0;
  for (let i = 0; i < flushes; i++) {
    for (let j = 0; j < perFlush; j++) {
      retext(meshes[next % meshes.length], width, height);
      next += 1;
    }
    draws.invalidate();
    draws.flush();
    const flushed = uploadedBytes(arraysOf(container), seen, versions);
    bytes += flushed.bytes;
    fresh += flushed.fresh;
  }
  const ms = performance.now() - startedAt;
  const arrays = arraysOf(container);
  const depth = arrays.size ? [...arrays][0].image.depth : 0;

  console.log(
    label.padEnd(30) +
      String(perFlush).padStart(8) +
      String(depth).padStart(7) +
      KB(mounting).padStart(11) +
      KB(bytes / flushes).padStart(11) +
      `${(ms / flushes).toFixed(3)} ms`.padStart(11) +
      String(fresh).padStart(9),
  );
}

console.log(
  "\nDepth is the array's layer count. `per flush` is what the renderer would" +
    "\nupload for one flush, by the rule in WebGLTextures.uploadTexture.\n",
);
console.log(
  "panel".padEnd(30) +
    "changed".padStart(8) +
    "depth".padStart(7) +
    "mounting".padStart(11) +
    "per flush".padStart(11) +
    "per flush".padStart(11) +
    "arrays".padStart(9),
);
console.log("-".repeat(87));

// The shapes a panel actually makes. A readout is the full width of its box;
// a button's label is shorter. The sizes are rasterized pixel sizes of a run
// at the device pixel ratio a headset reports, which is where the classes
// come from. paperwings-xr's own panel is the first row.
measure("8 readouts, 256x32", 8, 256, 32, 1);
measure("24 labels, 128x24", 24, 128, 24, 1);
measure("64 labels, 128x24", 64, 128, 24, 1);
measure("200 labels, 128x24", 200, 128, 24, 1);
measure("8 readouts, 512x48 (dpr 2)", 8, 512, 48, 1);
console.log("-".repeat(87));
// The other end: a whole list re-rendering in one flush, where a strategy
// that uploads changed layers has nothing left to save.
measure("24 labels, 128x24", 24, 128, 24, 24);
measure("200 labels, 128x24", 200, 128, 24, 200);

console.log(
  "\nEvery one of these regenerates the same mip chain, over the same array," +
    "\nas often as it did before: three makes that call per upload, not per" +
    "\nlayer, and it covers a TEXTURE_2D_ARRAY whole either way.\n",
);
