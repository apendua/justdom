import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const requireFromCwd = createRequire(`${process.cwd()}/`);

const DEFAULT_HTML = "<!doctype html><html><body></body></html>";

/**
 * Creates a JSDOM instance and installs its globals on `globalThis`.
 *
 * It may be called more than once; every call replaces the previously installed
 * globals with the ones coming from the freshly created instance. The returned
 * instance can be used to serialize the document, or to close the window once
 * it is no longer needed.
 *
 * @param {{ ignoreCss?: boolean, html?: string }} [options]
 * @returns {JSDOM}
 */
export function setupJsdom({ ignoreCss = false, html = DEFAULT_HTML } = {}) {
  if (ignoreCss) {
    requireFromCwd.extensions[".css"] = () => {};
  }

  const dom = new JSDOM(html);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: dom.window.Node,
  });
  Object.defineProperty(globalThis, "Comment", {
    configurable: true,
    value: dom.window.Comment,
  });
  Object.defineProperty(globalThis, "DocumentFragment", {
    configurable: true,
    value: dom.window.DocumentFragment,
  });
  Object.defineProperty(globalThis, "Text", {
    configurable: true,
    value: dom.window.Text,
  });
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    value: dom.window.Event,
  });
  Object.defineProperty(globalThis, "MouseEvent", {
    configurable: true,
    value: dom.window.MouseEvent,
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: dom.window.Element,
  });
  standInForPointers(dom.window);
  Object.defineProperty(globalThis, "PointerEvent", {
    configurable: true,
    value: dom.window.PointerEvent,
  });

  return dom;
}

/**
 * Give a jsdom window what a browser has for pointers and jsdom does not:
 * `PointerEvent`, as a `MouseEvent` that carries a pointer's id, type and
 * whether it is the primary one, and the three pointer capture methods on
 * `Element`. The only pointer a browser knows of here is the mouse's, whose
 * id is 1, so capturing any other throws a `NotFoundError`, as a browser
 * refuses a pointer it has no record of.
 *
 * @param {import("jsdom").DOMWindow} window
 */
function standInForPointers(window) {
  if (typeof window.PointerEvent !== "function") {
    window.PointerEvent = /** @type {typeof PointerEvent} */ (
      /** @type {unknown} */ (
        class PointerEvent extends window.MouseEvent {
          /**
           * @param {string} type
           * @param {PointerEventInit} [init]
           */
          constructor(type, init = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 0;
            this.pointerType = init.pointerType ?? "";
            this.isPrimary = init.isPrimary ?? false;
          }
        }
      )
    );
  }
  const proto = window.Element.prototype;
  if (typeof proto.setPointerCapture === "function") {
    return;
  }
  /** The elements that hold the mouse's pointer. */
  const mouseCaptures = new WeakSet();
  Object.assign(proto, {
    /** @param {number} id */
    setPointerCapture(id) {
      if (id !== 1) {
        throw new window.DOMException(
          "No active pointer with the given id is found.",
          "NotFoundError",
        );
      }
      mouseCaptures.add(this);
    },
    /** @param {number} id */
    releasePointerCapture(id) {
      if (id === 1) {
        mouseCaptures.delete(this);
      }
    },
    /** @param {number} id */
    hasPointerCapture(id) {
      return id === 1 && mouseCaptures.has(this);
    },
  });
}
