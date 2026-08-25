declare global {
  interface HTMLElement {
    readonly __EVENT_MAP__: HTMLElementEventMap;
  }

  interface SVGElement {
    readonly __EVENT_MAP__: SVGElementEventMap;
  }

  interface FontFaceSet {
    readonly __EVENT_MAP__: FontFaceSetEventMap;
  }
}

export {};
