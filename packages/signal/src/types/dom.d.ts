// The DOM's event targets, described as the `IEmitter`s that `on` and
// `fromEvent` take. Each carries its event map as a phantom `__EVENT_MAP__`
// property, which the DOM's lib does not give it. The browser packages,
// `justdom-core` and `justdom-three`, reference this file from their entry
// points, so an app that imports either has the declarations without copying
// them. The package's own entry point does not, so that a program without the
// DOM lib can use it.
declare global {
  interface HTMLElement {
    readonly __EVENT_MAP__: HTMLElementEventMap;
  }

  interface SVGElement {
    readonly __EVENT_MAP__: SVGElementEventMap;
  }

  interface Window {
    readonly __EVENT_MAP__: WindowEventMap;
  }

  interface Document {
    readonly __EVENT_MAP__: DocumentEventMap;
  }

  interface FontFaceSet {
    readonly __EVENT_MAP__: FontFaceSetEventMap;
  }
}

export {};
