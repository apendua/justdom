import { addDependency, createProperty, Stream } from "justdom-signal";

interface Dimensions {
  width: number;
  height: number;
}

/** Says each time `element` is resized, and once as it is first observed. */
const resizesOf = (element: Element) =>
  new Stream<ResizeObserverEntry[]>((subscriber) => {
    const observer = new ResizeObserver((entries) => subscriber.next(entries));
    observer.observe(element);
    return () => observer.disconnect();
  });

/**
 * The size of the element the board is laid out in. Not the window's: the
 * page sets the menu beside or above the board, and the board is fitted to
 * what the menu leaves it, so that no tile is ever under the card.
 */
class Root {
  readonly #element: Element;
  readonly #resizes: Stream<ResizeObserverEntry[]>;

  constructor(element: Element) {
    this.#element = element;
    this.#resizes = resizesOf(element);
  }

  public get dimensions(): Dimensions {
    addDependency(this.#resizes);
    return { width: this.#element.clientWidth, height: this.#element.clientHeight };
  }

  public get screenWidth(): number {
    return this.dimensions.width;
  }

  public get screenHeight(): number {
    return this.dimensions.height;
  }
}

export const RootContext = createProperty(() => new Root(document.documentElement));

export default Root;
