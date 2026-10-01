/**
 * The `DataTransfer` a drag out of a panel carries, and the two tables of
 * the HTML drag-and-drop model that turn its effects into an operation.
 *
 * A browser's own `DataTransfer` cannot be used. Chromium does not count the
 * one `new DataTransfer()` builds as a drag-and-drop transfer, and ignores
 * every write to its `dropEffect` and `effectAllowed`. A page that sets
 * `effectAllowed = "move"` in `dragstart` and `dropEffect = "move"` in
 * `dragover`, as every page that sorts a list does, would be told that
 * nothing may be dropped anywhere. This class is the drag data store the
 * specification describes, and it keeps the store's modes. A page can write
 * only in `dragstart`, can see the types but not the data while the drag is
 * under way, and can read the data in `drop`. A page that works against it
 * works against a browser's.
 *
 * What it leaves out is what a hand in a headset cannot give it: `files`
 * is always empty, and there is no `items` list, since nothing is ever
 * dragged in from outside the page.
 */

/**
 * @typedef {"readwrite" | "protected" | "readonly"} DragDataStoreMode
 */

/** @typedef {"none" | "copy" | "link" | "move"} DropEffect */

/**
 * @typedef {"none" | "copy" | "copyLink" | "copyMove" | "link" | "linkMove"
 *   | "move" | "all" | "uninitialized"} EffectAllowed
 */

/**
 * Which operations each `effectAllowed` permits, and so which `dropEffect`
 * a `dragover` or a `drop` may settle on. The first of each is the one a
 * `dragenter` and a `dragover` start from, as the specification's table of
 * initial `dropEffect`s has it; an element being dragged is its "any other
 * case", which starts from `copy`.
 *
 * @type {Readonly<Record<EffectAllowed, readonly DropEffect[]>>}
 */
const ALLOWED = Object.freeze({
  none: [],
  copy: ["copy"],
  copyLink: ["copy", "link"],
  copyMove: ["copy", "move"],
  link: ["link"],
  linkMove: ["link", "move"],
  move: ["move"],
  all: ["copy", "link", "move"],
  uninitialized: ["copy", "link", "move"],
});

/** @type {ReadonlySet<string>} */
const DROP_EFFECTS = new Set(["none", "copy", "link", "move"]);

/**
 * The `dropEffect` a `dragenter` or a `dragover` is dispatched with.
 *
 * @param {EffectAllowed} effectAllowed
 * @returns {DropEffect}
 */
export function initialDropEffect(effectAllowed) {
  return ALLOWED[effectAllowed][0] ?? "none";
}

/**
 * The operation a cancelled `dragover` or `drop` settles on: what the page
 * asked for in `dropEffect`, if the source allowed it, and none otherwise.
 *
 * @param {EffectAllowed} effectAllowed
 * @param {DropEffect} dropEffect
 * @returns {DropEffect}
 */
export function resolveOperation(effectAllowed, dropEffect) {
  return ALLOWED[effectAllowed].includes(dropEffect) ? dropEffect : "none";
}

/**
 * The formats `getData` and `setData` spell differently from how they
 * store them.
 *
 * @param {string} format
 * @returns {string}
 */
function normalizeFormat(format) {
  const lower = format.toLowerCase();
  if (lower === "text") {
    return "text/plain";
  }
  if (lower === "url") {
    return "text/uri-list";
  }
  return lower;
}

/**
 * The drag data store of one drag, behind the `DataTransfer` interface.
 */
export class PanelDataTransfer {
  /** @type {Map<string, string>} */
  #data = new Map();

  /** @type {DragDataStoreMode} */
  #mode = "readwrite";

  /** @type {DropEffect} */
  #dropEffect = "none";

  /** @type {EffectAllowed} */
  #effectAllowed = "uninitialized";

  /** @type {{ element: Element, x: number, y: number } | null} */
  #dragImage = null;

  /** @type {readonly string[]} */
  #types = Object.freeze([]);

  /** @type {readonly File[]} */
  files = Object.freeze([]);

  /**
   * What the drag is allowed to be at this point: written in `dragstart`,
   * guarded while it is under way, and read in `drop`. The drag sets it
   * before each event it dispatches.
   *
   * @param {DragDataStoreMode} mode
   */
  setMode(mode) {
    this.#mode = mode;
  }

  /** @returns {DropEffect} */
  get dropEffect() {
    return this.#dropEffect;
  }

  /** @param {string} value */
  set dropEffect(value) {
    if (DROP_EFFECTS.has(value)) {
      this.#dropEffect = /** @type {DropEffect} */ (value);
    }
  }

  /** @returns {EffectAllowed} */
  get effectAllowed() {
    return this.#effectAllowed;
  }

  /** @param {string} value */
  set effectAllowed(value) {
    if (this.#mode === "readwrite" && Object.hasOwn(ALLOWED, value)) {
      this.#effectAllowed = /** @type {EffectAllowed} */ (value);
    }
  }

  /**
   * The formats set in `dragstart`, in the order they were set. Readable in
   * every mode: it is what a `dragover` decides whether to accept by.
   *
   * @returns {readonly string[]}
   */
  get types() {
    return this.#types;
  }

  /**
   * @param {string} format
   * @returns {string}
   */
  getData(format) {
    if (this.#mode === "protected") {
      return "";
    }
    const normalized = normalizeFormat(format);
    const data = this.#data.get(normalized) ?? "";
    if (format.toLowerCase() === "url") {
      // The first URL of the list, as the specification has it.
      return data.split(/\r?\n/).find((line) => line !== "" && !line.startsWith("#")) ?? "";
    }
    return data;
  }

  /**
   * @param {string} format
   * @param {string} data
   * @returns {void}
   */
  setData(format, data) {
    if (this.#mode !== "readwrite") {
      return;
    }
    const normalized = normalizeFormat(format);
    this.#data.delete(normalized);
    this.#data.set(normalized, String(data));
    this.#types = Object.freeze([...this.#data.keys()]);
  }

  /**
   * @param {string} [format] Every format when left out.
   * @returns {void}
   */
  clearData(format) {
    if (this.#mode !== "readwrite") {
      return;
    }
    if (format === undefined) {
      this.#data.clear();
    } else {
      this.#data.delete(normalizeFormat(format));
    }
    this.#types = Object.freeze([...this.#data.keys()]);
  }

  /**
   * What the drag is shown as, and where the hand holds it. The ghost takes
   * the element's size and holds it at `x`, `y` px from its corner.
   *
   * @param {Element} element
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  setDragImage(element, x, y) {
    if (this.#mode !== "readwrite") {
      return;
    }
    this.#dragImage = { element, x, y };
  }

  /**
   * What `setDragImage` was last given, for the ghost.
   *
   * @returns {{ element: Element, x: number, y: number } | null}
   */
  getDragImage() {
    return this.#dragImage;
  }
}
