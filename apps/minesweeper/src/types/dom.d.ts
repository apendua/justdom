declare global {
  interface HTMLElement {
    readonly __EVENT_MAP__: HTMLElementEventMap;
  }

  interface SVGElement {
    __EVENT_MAP__: SVGElementEventMap;
  }

  // The window is an event target like any other, and saying so here is what
  // lets `fromEvent` from `@apendua/signal` be used on it: the core's is typed
  // for an `IEmitter`, which carries its event map as a phantom property, and
  // the DOM's lib does not give `Window` one.
  interface Window {
    readonly __EVENT_MAP__: WindowEventMap;
  }
}

export {};
