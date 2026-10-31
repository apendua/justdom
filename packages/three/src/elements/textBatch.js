import * as THREE from "three";
import { createProperty } from "justdom-signal";
import { TEXT_ANISOTROPY } from "./textHelpers.js";
import { grownCapacity } from "./instancing.js";

/**
 * A panel's text runs, as the panel's one batch draws them
 * (`paintBatch.js`), together instead of one at a time.
 *
 * A run is rasterized to a canvas of its own, and that is the whole problem: a
 * texture is bound per draw, so a panel of eight hundred labels is eight
 * hundred draws no matter how alike they are. Nothing here changes how a run
 * is drawn — the same canvas, the same glyphs, the same kerning, decorations
 * and shadows — only where those pixels live and how the quad is issued.
 *
 * They live in **texture arrays keyed by the exact size of the run**, which is
 * the one arrangement that survives mipmapping. That is not a detail: text in
 * a panel is drawn well under 1:1 at arm's length, and an unmipped sample
 * there crawls as the head moves, which is why every run is mipmapped today.
 *
 * A shared atlas cannot keep that. Its mip chain is built across everything
 * packed into it, so a reduced level samples whatever landed next door — and
 * no amount of gutter fixes it, because the level is chosen from derivatives
 * in atlas space and a deep enough level spans the neighbours whatever the
 * spacing. Measured against the per-run drawing it replaces, an atlas came out
 * visibly bolder across a whole panel; an array of exactly-sized layers came
 * out indistinguishable. Padding a run into a rounder layer size brings the
 * same fault back, in miniature, by averaging the run with its own padding —
 * so the classes are exact, and runs of a size share an array.
 *
 * What that costs is an array per size, and a draw of the one batch samples
 * at most `ARRAYS_PER_DRAW` of them (`paintBatch.js`). This batch keeps the
 * arrays and its members' layers in them, and draws nothing of its own.
 *
 * Two things stay out. A run whose colours are baked into its texture — text
 * with a shadow or a decoration the mirror cannot tint — is sRGB where a mask
 * is raw coverage, and one array cannot be both. And a run keeps its mesh, so
 * a ray still finds the label it is pointing at; only `material.visible` goes
 * false, exactly as a batched box's does.
 */

/**
 * The batch a portal's text belongs to. Set by `createPortal` on the context
 * it builds its elements with, so each portal batches its own, and text built
 * without one — a test standing in for a portal — draws itself as it always
 * did.
 */
export const TextBatchContext = createProperty(
  /**
   * @returns {TextBatch | null}
   */
  () => null,
);

/** How many runs of a size an array has room for before it is grown. */
const MINIMUM_LAYERS = 8;

/**
 * How deep an array is allowed to get.
 *
 * `MAX_ARRAY_TEXTURE_LAYERS` is the real limit and it is a device's to state:
 * WebGL2 guarantees only 256, while the desktop and mobile parts this runs on
 * report 2048. Asking for the real one would mean reaching a GL context from
 * here, which this file has no business holding — a batch is given a container
 * and nothing else — so it takes the guarantee instead. Past it a run is
 * declined and draws itself, which costs a draw call and is what the whole
 * panel did before there were batches at all; over the guarantee it would be
 * a failed allocation and a size class that draws nothing.
 *
 * A panel would have to put 256 labels of one exact pixel size in front of the
 * player to reach this. That is a long list, and a long list is exactly what
 * batching is for — so the runs that go over do not fall off, they merely stop
 * being cheap.
 */
const MAXIMUM_LAYERS = 256;

/** What `acquire` returns when a size class has no layer left to give. */
const NO_LAYER = -1;

/**
 * The runs of one exact size, and the array texture holding them.
 *
 * Layers are handed out and taken back rather than repacked: a label whose
 * text changes gives its layer back and takes one off the free list, most
 * often the same one, and disturbs nobody else's. What reaches the GPU is the
 * whole array, freshly allocated, once per rebuild that changed anything --
 * `commit` says why a layer at a time was not enough.
 */
class SizeClass {
  /** @type {THREE.DataArrayTexture | null} */
  texture = null;
  /** @type {Uint8Array | null} */
  data = null;
  capacity = 0;
  /** @type {number[]} */
  free = [];
  next = 0;
  /** Bumped when the texture object is replaced, so the draws rebind. */
  generation = 0;
  /** Whether a shown run changed the mirror since the texture was built. */
  stale = false;
  /**
   * The layers prepared runs wrote since the texture was built, which the
   * texture does not hold. Kept apart from `stale` because a rebuild commits
   * only for a shown run (rule 12 in `docs/freedom-text-step-cache.md`):
   * the prepare pump writes a class over many frames, and committing it at
   * each rebuild between them would upload the growing array again every
   * time. Kept per layer so that a layer given back takes its claim on a
   * build with it, and so that a shown run drawing from one can be told.
   *
   * @type {Set<number>}
   */
  #staged = new Set();

  /**
   * @param {number} width
   * @param {number} height
   */
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  /** Whether the mirror holds layers the texture does not. */
  get staged() {
    return this.#staged.size > 0;
  }

  /**
   * Whether `layer` was written by a prepared run and not built since.
   *
   * @param {number} layer
   * @returns {boolean}
   */
  isStaged(layer) {
    return this.#staged.has(layer);
  }

  /** @returns {number} */
  get layerBytes() {
    return this.width * this.height * 4;
  }

  /**
   * Room in the mirror for this many layers. The texture is not touched
   * here: `commit` builds it, once, after every write of a rebuild is in.
   *
   * Growth for a prepared run marks nothing: the layer it makes room for is
   * marked when it is written, and a layer never written needs no build.
   *
   * @param {number} needed
   * @param {boolean} staged Whether a prepared run is what needs the room.
   * @returns {void}
   */
  #reserve(needed, staged) {
    if (needed <= this.capacity) {
      return;
    }
    const capacity = grownCapacity(this.capacity, needed, MINIMUM_LAYERS);
    const data = new Uint8Array(this.layerBytes * capacity);
    if (this.data) {
      data.set(this.data);
    }
    this.data = data;
    this.capacity = capacity;
    if (!staged) {
      this.stale = true;
    }
  }

  /**
   * The texture the one batch's draws sample, rebuilt from the mirror whenever
   * any of it changed since the last rebuild -- a new `DataArrayTexture` over
   * the same bytes, and the old one disposed -- rather than the old texture
   * told which layer to re-upload.
   *
   * That was the first design, and three does the right thing with it: one
   * `texSubImage3D` for the layer, then `generateMipmap` over the array. A
   * headset's driver does not. On Quest the mip chain of an array whose
   * storage already existed stayed as it was after a layer went up: the run
   * read right at arm's length, where level 0 is sampled, and blended into
   * whatever the layer held before -- the previous value of a readout, or
   * nothing -- as the player stepped back and the smaller levels took over.
   * A label written into a fresh array was never affected, which is the
   * tell: the mips come out right when `texStorage3D` has just been called
   * and not otherwise. So every change gets fresh storage.
   *
   * What that costs is the upload, and only the upload: three regenerates
   * the mip chain in `uploadTexture`, after whichever branch it took, and
   * for an array that call covers every layer -- so both ways regenerate the
   * same mips just as often, and the old way said as much itself. What
   * changed is that a flush now sends the array rather than the layers that
   * moved. `bench/textBatch.bench.mjs` measures it: on a panel of eight
   * readouts, 36 kB a change becomes 256 kB; on two hundred labels of one
   * size, 60 kB becomes 3 MB, which is the worst of it and the reason
   * `MAXIMUM_LAYERS` is worth an eye. The penalty is bounded by how much of
   * the array a flush changes -- a list that re-renders at once pays 1.3x,
   * since the old way was already uploading nearly all of it -- and a
   * panel's labels change on a press or a tick of a clock, which is a
   * handful a second and not a frame.
   *
   * Called between the writes of a rebuild and the draws' rebind, which is
   * the one order that works: a draw reads the texture off its class when
   * its generation moves, so the texture has to be the new one by then.
   *
   * @returns {void}
   */
  commit() {
    if (this.stale) {
      this.#build();
    }
  }

  /**
   * Build the texture for what prepared runs wrote, which `commit` leaves
   * alone. The prepare pump calls it once it has written every run.
   *
   * @returns {boolean} Whether there was anything to build.
   */
  commitStaged() {
    if (!this.#staged.size) {
      return false;
    }
    this.#build();
    return true;
  }

  /**
   * A fresh texture over the whole mirror, which carries every layer in it,
   * shown and staged alike.
   *
   * @returns {void}
   */
  #build() {
    this.stale = false;
    this.#staged.clear();
    if (!this.data) {
      return;
    }
    if (this.texture) {
      this.texture.dispose();
    }
    const texture = new THREE.DataArrayTexture(this.data, this.width, this.height, this.capacity);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    // Coverage, not colour: tagged sRGB the hardware would linearize every
    // sample and the glyph edges would collapse to a thin rim -- the same
    // reason the per-run mask texture is untagged.
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // And across the foreshortening, for the reason `TEXT_ANISOTROPY` gives:
    // a batched run is on a panel that is hardly ever square-on to the eye.
    texture.anisotropy = TEXT_ANISOTROPY;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    this.texture = texture;
    this.generation += 1;
  }

  /**
   * A layer to write a run's pixels into, or `NO_LAYER` if this class is full.
   *
   * Only the growth path can fail. A layer off the free list is one this array
   * already has room for, whatever the cap says — which matters, because it is
   * how a run declined earlier gets in once another leaves.
   *
   * @param {boolean} [staged] Whether the layer is for a prepared run.
   * @returns {number}
   */
  acquire(staged = false) {
    if (this.free.length) {
      const layer = /** @type {number} */ (this.free.pop());
      this.#reserve(layer + 1, staged);
      return layer;
    }
    if (this.next >= MAXIMUM_LAYERS) {
      return NO_LAYER;
    }
    const layer = this.next++;
    this.#reserve(layer + 1, staged);
    return layer;
  }

  /**
   * @param {number} layer
   * @returns {void}
   */
  release(layer) {
    if (layer === NO_LAYER) {
      return;
    }
    this.#staged.delete(layer);
    this.free.push(layer);
  }

  /** Whether every layer this class ever handed out has come back. */
  get empty() {
    return this.free.length === this.next;
  }

  /**
   * Give back the storage of a class nobody is using.
   *
   * A size class outlives its runs, and until now so did everything it was
   * holding: a panel whose labels are all re-rasterized at a new size — which
   * is what a change of device pixel ratio does to every one of them at once —
   * left the array behind it allocated at its high-water mark, on the device
   * and again in the mirror of it kept here, for as long as the panel was
   * open. At a layer per label and `width * height * 4` bytes a layer, twice,
   * that is worth tens of megabytes on a panel that has since moved on.
   *
   * The instance stays in the map. A draw holds the size classes it samples
   * directly, so a class dropped and made again under the same key would leave
   * a draw pointing at a dead one; keeping it means identity holds still,
   * `#reserve` builds a fresh array from `MINIMUM_LAYERS` the next time a run
   * of this size appears, and the generation bump makes the draws rebind to the
   * new texture before anything draws with it. What is left behind is an object
   * with two numbers in it.
   *
   * @returns {boolean} Whether there was anything to give back.
   */
  releaseStorageIfEmpty() {
    if (!this.empty || (!this.texture && !this.data)) {
      return false;
    }
    this.dispose();
    this.free = [];
    this.next = 0;
    return true;
  }

  /**
   * Copy a run's pixels into its layer of the mirror. What goes up, and
   * when, is `commit`'s.
   *
   * @param {number} layer
   * @param {HTMLCanvasElement} canvas
   * @param {boolean} [staged] Whether the pixels are a prepared run's.
   * @returns {void}
   */
  write(layer, canvas, staged = false) {
    const context = canvas.getContext("2d");
    if (layer === NO_LAYER || !context || !this.data) {
      return;
    }
    const pixels = context.getImageData(0, 0, this.width, this.height).data;
    this.data.set(pixels, layer * this.layerBytes);
    if (staged) {
      this.#staged.add(layer);
    } else {
      this.stale = true;
    }
  }

  /** @returns {void} */
  dispose() {
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    this.data = null;
    this.capacity = 0;
    this.stale = false;
    this.#staged.clear();
  }
}

/**
 * Which layer of which array holds the pixels of one of a run's rasters.
 *
 * @typedef {object} Slot
 * @property {SizeClass} sizeClass
 * @property {number} layer
 */

/**
 * What the batch keeps about one run between rebuilds: a layer for each of
 * the run's rasters it has copied, keyed by the canvas the pixels came from,
 * and which of them the run is showing.
 *
 * More than one, because a run keeps its rasters at the steps its panel
 * holds (`textRun.js`), and a layer kept with each is what lets the panel
 * go back to one of those steps without writing or uploading anything: the
 * run shows a canvas the batch already has, and every array stays as it is.
 * A layer goes back when the run lets go of its raster (`forget`) or leaves
 * the batch (`remove`), and only then.
 *
 * @typedef {object} Member
 * @property {THREE.Mesh} mesh
 * @property {{ value: THREE.Vector4 }} clip The run's clip uniform (`textRun.js`).
 * @property {Map<HTMLCanvasElement, Slot>} slots
 * @property {Slot | null} shown The layer the run is drawn from, as the
 *   last walk settled it (`take`); null while it draws itself.
 * @property {number} width
 * @property {number} height
 */

export class TextBatch {
  /** @type {Map<THREE.Mesh, Member>} */
  #members = new Map();
  /** @type {Map<string, SizeClass>} */
  #classes = new Map();
  /**
   * What draws the runs, with the panel's boxes.
   *
   * @type {import('./paintBatch.js').PaintBatch}
   */
  #draw;
  /**
   * The runs the last walk took, so that a run leaving the batch, or letting go
   * of a raster, asks for a rebuild only when the one batch draws it or a run
   * is waiting for a layer (`#declined`); see `#drawn` in `boxBatch.js`. What
   * such a run gives back is given back all the same, and a class it leaves
   * with no layers is dropped by whichever rebuild comes next.
   *
   * @type {Set<THREE.Mesh>}
   */
  #drawn = new Set();
  /**
   * Whether the last rebuild declined a run for want of a layer. Such a run
   * waits for a layer to come back, from any run of its size, drawn or not,
   * so while one waits every release asks for a rebuild, `#drawn` or no.
   */
  #declined = false;

  /**
   * @param {import('./paintBatch.js').PaintBatch} draw What draws the runs.
   */
  constructor(draw) {
    this.#draw = draw;
  }

  /**
   * A walk of the panel starts, which takes the runs it meets (`take`).
   *
   * @returns {void}
   */
  beginWalk() {
    this.#drawn.clear();
    this.#declined = false;
  }

  /**
   * If `mesh` is a run this batch has taken in, settle it (`#settle`),
   * mark it drawn by the walk under way and hand it back, with where its
   * pixels are in `shown`; null for a run the batch cannot draw, which
   * draws itself, and for any other mesh. A run draws itself exactly when
   * this says null, and this is the one place that decides, so a run that
   * changes its mind, by gaining a decoration the mirror cannot tint, is
   * handed back rather than lost.
   *
   * @param {THREE.Mesh} mesh
   * @returns {Member | null}
   */
  take(mesh) {
    const member = this.#members.get(mesh);
    if (!member) {
      return null;
    }
    member.shown = this.#settle(member);
    const batched = member.shown !== null;
    /** @type {THREE.Material} */ (mesh.material).visible = !batched;
    mesh.frustumCulled = !batched;
    if (!batched) {
      return null;
    }
    this.#drawn.add(mesh);
    return member;
  }

  /**
   * Build the texture of every class a walk changed, once every run it met
   * is settled, before anything binds one.
   *
   * @returns {void}
   */
  commitClasses() {
    for (const sizeClass of this.#classes.values()) {
      sizeClass.commit();
    }
  }

  /**
   * Once a walk has settled and written everything, a class whose every
   * layer has come back is one no run in the panel is in, at any step its
   * panel holds. Give its array back rather than hold the panel's
   * high-water mark until it closes.
   *
   * @returns {void}
   */
  releaseEmptyClasses() {
    for (const sizeClass of this.#classes.values()) {
      sizeClass.releaseStorageIfEmpty();
    }
  }

  /**
   * Take this run into the batch. Idempotent.
   *
   * Two kinds of run are never offered at all, and for the same reason: a
   * batched run is described entirely by what the one batch copied out of it,
   * so anything private to the run has nowhere to go. A run whose colours are
   * baked into its texture is declined below, by `#settle`, because one array
   * texture cannot hold both coverage and colour. A run that is *revealed* is
   * not offered by `textRun.js` in the first place, because it carries a cut
   * uniform of its own — and making that cut a vertex attribute instead would
   * dirty the batch on every keystroke, which is the one thing that could
   * make a reveal cost more than the rewriting it replaces.
   *
   * @param {THREE.Mesh} mesh
   * @param {{ value: THREE.Vector4 }} clip The clip uniform the run keeps,
   *   which is the one piece of a run's description the mesh does not carry.
   * @returns {void}
   */
  add(mesh, clip) {
    if (this.#members.has(mesh)) {
      return;
    }
    this.#members.set(mesh, {
      mesh,
      clip,
      slots: new Map(),
      shown: null,
      width: 0,
      height: 0,
    });
    // Deliberately not hidden here. Whether this run can be batched at all is
    // not known until its texture is looked at — a run whose colours are baked
    // in cannot be — and hiding it first would take a label out of the draw
    // that nothing else was going to draw. The rebuild decides, and until it
    // runs the run draws itself, which is the right answer either way.
    this.invalidate();
  }

  /**
   * @param {THREE.Mesh} mesh
   * @returns {void}
   */
  remove(mesh) {
    const member = this.#members.get(mesh);
    if (!member) {
      return;
    }
    for (const slot of member.slots.values()) {
      slot.sizeClass.release(slot.layer);
    }
    this.#members.delete(mesh);
    if (mesh.material) {
      /** @type {THREE.Material} */ (mesh.material).visible = true;
    }
    mesh.frustumCulled = true;
    if (this.#drawn.delete(mesh) || this.#declined) {
      this.invalidate();
    }
  }

  /**
   * Give back the layer a run's raster was copied into, because the run has
   * let go of the raster: its panel no longer holds the step it was drawn
   * at, or what the run says changed. Nothing to give back for a raster the
   * batch never copied, which is every raster of a run it does not draw.
   *
   * Told by the run, at the commit that stops it showing the raster or after
   * it, and never sooner. A layer given back while the run still showed its
   * canvas would be taken again by the next rebuild and never returned.
   *
   * @param {THREE.Mesh} mesh
   * @param {HTMLCanvasElement} canvas
   * @returns {void}
   */
  forget(mesh, canvas) {
    const member = this.#members.get(mesh);
    const slot = member?.slots.get(canvas);
    if (!member || !slot) {
      return;
    }
    slot.sizeClass.release(slot.layer);
    member.slots.delete(canvas);
    if (this.#drawn.has(mesh) || this.#declined) {
      this.invalidate();
    }
  }

  /**
   * Copy a raster the run is not showing yet into a layer of its own, for a
   * step its panel is preparing. The layer is marked staged, not stale, so
   * no rebuild builds its class for it; `commitStaged` does, once every run
   * is prepared. When the run later shows the canvas, `#settle` finds the
   * layer, and nothing is copied or built at the crossing, unless the panel
   * crossed before the pump built the class, and then that rebuild does.
   *
   * Only for a mask: a raster with its colours baked in is never batched.
   * Nothing for a run the batch has not taken in yet, or one whose class is
   * full; it is copied at the crossing instead, as if it was never prepared.
   *
   * @param {THREE.Mesh} mesh
   * @param {HTMLCanvasElement} canvas
   * @returns {boolean} Whether the batch has the canvas, to draw from once
   *   the run shows it.
   */
  stage(mesh, canvas) {
    const member = this.#members.get(mesh);
    if (!member || !canvas.width || !canvas.height) {
      return false;
    }
    if (member.slots.has(canvas)) {
      return true;
    }
    const sizeClass = this.#classFor(canvas);
    const layer = sizeClass.acquire(true);
    if (layer === NO_LAYER) {
      return false;
    }
    sizeClass.write(layer, canvas, true);
    member.slots.set(canvas, { sizeClass, layer });
    return true;
  }

  /**
   * Build and upload the arrays of the classes `stage` wrote into: at most
   * `bytes` of them, and at least one class whatever its size. The draws
   * that sample a class are rebound to its new array here, in the same call
   * that disposed the old one, so nothing samples a disposed texture until
   * the next rebuild.
   *
   * @param {number} bytes
   * @param {(texture: THREE.Texture) => void} upload Send a texture to the
   *   GPU now rather than at the next render: `renderer.initTexture` in a
   *   session. The batch is given it rather than a renderer, which it has no
   *   business holding.
   * @returns {boolean} Whether staged classes are left for another call.
   */
  commitStaged(bytes, upload) {
    let spent = 0;
    for (const sizeClass of this.#classes.values()) {
      if (!sizeClass.staged) {
        continue;
      }
      const size = sizeClass.capacity * sizeClass.layerBytes;
      if (spent > 0 && spent + size > bytes) {
        return true;
      }
      if (!sizeClass.commitStaged() || !sizeClass.texture) {
        continue;
      }
      upload(sizeClass.texture);
      this.#draw.rebind(sizeClass);
      spent += size;
    }
    return false;
  }

  /**
   * The size class for a canvas of this size, made if there is none.
   *
   * @param {HTMLCanvasElement} canvas
   * @returns {SizeClass}
   */
  #classFor(canvas) {
    const key = `${canvas.width}x${canvas.height}`;
    let sizeClass = this.#classes.get(key);
    if (!sizeClass) {
      sizeClass = new SizeClass(canvas.width, canvas.height);
      this.#classes.set(key, sizeClass);
    }
    return sizeClass;
  }

  /**
   * Something about a run the batch has copied down has changed. The one
   * batch coalesces it with everything else the panel changed (`invalidate`
   * in `paintBatch.js`).
   *
   * @returns {void}
   */
  invalidate() {
    this.#draw.invalidate();
  }

  /**
   * Make sure the pixels of the raster a run shows are in an array. A canvas
   * the batch has a layer for already, which is a run gone back to a step its
   * panel held, writes nothing, and the array it is in is not built again.
   * Only a canvas the batch has not seen is copied, into a layer of its own.
   *
   * @param {Member} member
   * @returns {Slot | null} The layer the run is drawn from, or null when the
   *   batch cannot draw it.
   */
  #settle(member) {
    const material = /** @type {THREE.MeshBasicMaterial} */ (member.mesh.material);
    // A baked run carries its colours in its texture; a mask carries coverage.
    // One array cannot be both, so only masks are batched.
    const texture = material.alphaMap;
    const canvas = texture ? /** @type {HTMLCanvasElement} */ (texture.image) : null;
    if (!canvas || !canvas.width || !canvas.height) {
      return null;
    }
    const positions = /** @type {THREE.BufferAttribute} */ (
      member.mesh.geometry.getAttribute("position")
    ).array;
    member.width = positions[3];
    member.height = positions[7];
    let slot = member.slots.get(canvas);
    if (!slot) {
      const sizeClass = this.#classFor(canvas);
      const layer = sizeClass.acquire();
      if (layer === NO_LAYER) {
        // Full. The run draws itself, exactly as one with baked colours does,
        // and is asked again on the next rebuild — which is what lets it in
        // when another run of its size goes away, since `remove` and `forget`
        // invalidate while a run is declined (`#declined`).
        this.#declined = true;
        return null;
      }
      slot = { sizeClass, layer };
      sizeClass.write(layer, canvas);
      member.slots.set(canvas, slot);
    } else if (slot.sizeClass.isStaged(slot.layer)) {
      // Prepared, and the panel crossed before the pump built its class:
      // drawn now, so this rebuild builds it, as a shown write would.
      slot.sizeClass.stale = true;
    }
    return slot;
  }

  /** @returns {void} */
  dispose() {
    for (const sizeClass of this.#classes.values()) {
      sizeClass.dispose();
    }
    this.#classes.clear();
    this.#members.clear();
    this.#drawn.clear();
  }
}
