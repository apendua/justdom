declare global {
  interface HTMLElement {
    __EVENT_MAP__: HTMLElementEventMap;
  }

  interface SVGElement {
    __EVENT_MAP__: SVGElementEventMap;
  }
}

export {};
