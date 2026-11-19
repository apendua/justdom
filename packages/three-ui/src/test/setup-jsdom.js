import { setupJsdom } from "@apendua/jsdom-env";

setupJsdom();

// jsdom-env exposes the common DOM globals, but not MutationObserver, which
// the portal uses to mirror a tree and the scrollable to notice content coming
// and going.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

// `getComputedStyle` is a window method rather than a global under jsdom-env;
// the text mirror reaches for the bare name, as it may on a page.
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
}

// jsdom lays nothing out, so a Range measures nothing either. A panel with
// text on it reaches for these; zeroes are the honest answer, since no test
// here is about where the glyphs landed.
if (typeof window.Range.prototype.getBoundingClientRect !== "function") {
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.Range.prototype.getClientRects = () => /** @type {any} */ ([]);
}

// jsdom has no FontFaceSet; VisualProperties consults it for x-height.
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loaded",
      ready: Promise.resolve(),
      addEventListener() {},
      removeEventListener() {},
    },
  });
}
