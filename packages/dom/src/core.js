import { combineLatest, distinctUntilChanged, map, Observable } from "rxjs";
import {
  moveSegmentBefore,
  removeSegment,
  replaceSegment,
  toSegment,
} from "./helpers";

/**
 * @import { Subscriber, Subscription } from "rxjs";
 */

/**
 * @typedef {boolean | number | string | null | undefined} Primitive
 */

/**
 * @template X
 * @template Y
 * @template [A=X]
 * @template [B=never]
 * @typedef {(
 *   (<T>() => T extends X ? 1 : 2) extends
 *   (<T>() => T extends Y ? 1 : 2) ? A : B
 * )} IfEquals
 */

/**
 * @template {object} T
 * @typedef {{
 *   [P in keyof T as IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] },
 *   T[P] extends (...args: any[]) => any ? never : P>]?: T[P] extends (...args: any[]) => any ? never : T[P];
 * }} WritableProps
 */

/**
 * @template E
 * @typedef {(e: E) => void} Handler
 */

/**
 * @template {object} EventMap
 * @typedef {{
 *   addEventListener: <K extends keyof EventMap>(type: K, listener: Handler<EventMap[K]>) => void;
 *   removeEventListener: <K extends keyof EventMap>(type: K, listener: Handler<EventMap[K]>) => void;
 * }} EventListener
 */

/**
 * Creates a text node observable.
 * @param {string | Observable<string>} value - The text content or an observable of text content.
 * @returns {Observable<Text>} An observable that emits a Text node.
 */
export function textNode(value) {
  return new Observable((subscriber) => {
    if (typeof value === "string") {
      const myTextNode = document.createTextNode(value);
      subscriber.next(myTextNode);
    } else {
      const myTextNode = document.createTextNode("");
      value.subscribe((newValue) => {
        myTextNode.textContent = newValue;
      });
      subscriber.next(myTextNode);
    }
  });
}

/**
 * Creates a class name observable.
 * @param {Observable<string>} value - An observable of CSS class content.
 * @returns {Observable<string>}
 */
export function style(value) {
  return new Observable((subscriber) => {
    const styleElement = document.createElement("style");
    const key = `class_${Math.random().toString(36).slice(2)}`;
    subscriber.add(
      value.subscribe((newValue) => {
        styleElement.innerHTML = `.${key} {\n${newValue}\n}`;
      }),
    );
    document.head.appendChild(styleElement);
    subscriber.next(key);
    return () => {
      document.head.removeChild(styleElement);
    };
  });
}

/**
 * Creates an observable that emits a single value.
 * @template T
 * @param {T} value - The value to emit.
 * @returns {Observable<T>} An observable that emits the value.
 */
function just(value) {
  return new Observable((subscriber) => {
    subscriber.next(value);
  });
}

/**
 * @typedef {string | number | Observable<string> | Observable<number>} Renderable
 */

/**
 * Renders text from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {Observable<string>} An observable that emits the rendered text.
 */
function renderText(strings, ...values) {
  if (values.length === 0) {
    return just(strings.join(""));
  }
  return combineLatest(
    values.map((value) => {
      if (value instanceof Observable) {
        return /** @type {Observable<unknown>} */ (value).pipe(
          map((v) => v?.toString() ?? ""),
        );
      }
      return just(value.toString());
    }),
  ).pipe(
    map((observedValues) => {
      let rendered = "";
      strings.forEach((str, index) => {
        rendered += str + (observedValues[index] || "");
      });
      return rendered;
    }),
  );
}

/**
 * Creates a string observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {Observable<string>} An observable that emits the rendered string.
 */
export function string(strings, ...values) {
  return renderText(strings, ...values);
}

/**
 * Creates a text node observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {Observable<Text>} An observable that emits a Text node.
 */
export function text(strings, ...values) {
  return textNode(renderText(strings, ...values));
}

/**
 * Creates a CSS class name observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {Observable<string>}
 */
export function css(strings, ...values) {
  return style(renderText(strings, ...values));
}

/**
 * @template T
 * @param {() => void} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function teardown(fn) {
  return (source) => {
    return new Observable((subscriber) => {
      source.subscribe(subscriber);
      return fn;
    });
  };
}

/**
 * Creates a document fragment observable from child observables.
 * @param {Array<Observable<Node | null>>} children - The child observables.
 * @returns {Observable<DocumentFragment>} An observable that emits a DocumentFragment.
 */
export function fragment(...children) {
  return new Observable((subscriber) => {
    /** @type {Map<number, [Node, Node]>} */
    const segments = new Map();
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < children.length; i++) {
      const node = fragment.appendChild(document.createComment(""));
      segments.set(i, toSegment(node));
    }

    children.forEach((child, i) => {
      subscriber.add(
        child
          .pipe(
            distinctUntilChanged(),
            teardown(() => {
              const oldSegment = segments.get(i);
              if (oldSegment) {
                removeSegment(oldSegment);
                segments.delete(i);
              }
            }),
          )
          .subscribe({
            next: (newNode) => {
              const oldSegment = segments.get(i);
              if (oldSegment) {
                segments.set(i, replaceSegment(newNode, oldSegment));
              }
            },
          }),
      );
    });

    subscriber.next(fragment);
    return () => {
      // TODO: I think this one is unnecessary. Let's use some tests
      //       to confirm it and remove it if it's not needed.
      for (const segment of segments.values()) {
        removeSegment(segment);
      }
    };
  });
}

/**
 * Creates a list observable from an array of items and a render function.
 * @template T
 * @param {Observable<T[]>} items - An observable of items.
 * @param {(item: T) => Observable<Exclude<Node, DocumentFragment>>} renderItem - A function to render an item.
 * @returns {Observable<DocumentFragment>} An observable that emits a DocumentFragment.
 */
export function list(items, renderItem) {
  return new Observable((subscriber) => {
    const fragment = document.createDocumentFragment();
    const listEnd = fragment.appendChild(document.createComment("LIST END"));
    /** @type {Map<T, [Node, Node]>} */
    const childSegments = new Map();
    /** @type {Map<T, Subscription>} */
    const childSubscriptions = new Map();
    subscriber.add(
      items.subscribe((newItems) => {
        for (let index = newItems.length - 1; index >= 0; index -= 1) {
          const item = newItems[index];
          let nextSegment;
          let i = index + 1;
          while (!nextSegment && i < newItems.length) {
            nextSegment = childSegments.get(newItems[i]);
            i += 1;
          }
          if (!childSegments.has(item)) {
            // NOTE: Only put placeholder where the new item should be inserted. The actual element
            //       will be inserted by the subscription.
            const nextNode = nextSegment?.[0] ?? listEnd;
            const { parentNode } = nextNode;
            if (parentNode) {
              const newComment = parentNode.insertBefore(
                document.createComment(""),
                nextNode,
              );
              childSegments.set(item, toSegment(newComment));
            }
          }
          if (!childSubscriptions.has(item)) {
            childSubscriptions.set(
              item,
              renderItem(item)
                .pipe(
                  distinctUntilChanged(),
                  teardown(() => {
                    const oldSegment = childSegments.get(item);
                    if (oldSegment) {
                      removeSegment(oldSegment);
                      childSegments.delete(item);
                    }
                    childSubscriptions.delete(item);
                  }),
                )
                .subscribe({
                  next: (newNode) => {
                    const oldSegment = childSegments.get(item);
                    if (oldSegment) {
                      childSegments.set(
                        item,
                        replaceSegment(newNode, oldSegment),
                      );
                    }
                  },
                }),
            );
          } else {
            const childSegment = childSegments.get(item);
            if (childSegment) {
              if (nextSegment) {
                if (
                  childSegment &&
                  childSegment[1].nextSibling !== nextSegment[0]
                ) {
                  moveSegmentBefore(childSegment, nextSegment[0]);
                }
              } else {
                moveSegmentBefore(childSegment, listEnd);
              }
            }
          }
        }
        const newItemsSet = new Set(newItems);
        for (const [item, childSegment] of childSegments.entries()) {
          if (!newItemsSet.has(item)) {
            removeSegment(childSegment);
            childSegments.delete(item);
          }
        }
        for (const [item, childSubscription] of childSubscriptions.entries()) {
          if (!newItemsSet.has(item)) {
            childSubscription.unsubscribe();
            childSubscriptions.delete(item);
          }
        }
      }),
    );
    subscriber.next(fragment);
    return () => {
      for (const subscription of childSubscriptions.values()) {
        subscription.unsubscribe();
      }
    };
  });
}
