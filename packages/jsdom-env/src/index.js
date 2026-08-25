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

  return dom;
}
