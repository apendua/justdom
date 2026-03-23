import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const requireFromCwd = createRequire(`${process.cwd()}/`);

/**
 * @param {{ ignoreCss?: boolean }} [options]
 */
export function setupJsdom({ ignoreCss = false } = {}) {
  if (ignoreCss) {
    requireFromCwd.extensions[".css"] = () => {};
  }

  const dom = new JSDOM("<!doctype html><html><body></body></html>");

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
}
