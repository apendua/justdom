declare global {
  interface HTMLElement {
    readonly __EVENT_MAP__: HTMLElementEventMap;
  }

  interface SVGElement {
    __EVENT_MAP__: SVGElementEventMap;
  }
}

export {};
