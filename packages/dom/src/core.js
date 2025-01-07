import { combineLatest, map, Observable } from "rxjs";

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
 *   T[P] extends Primitive ? P : never>]?: T[P] & Primitive
 * }} WritableProps
 */

/**
 * @template T
 * @typedef {T | (() => T) | Observable<T>} Getter
 */

/**
 * @param {Subscriber<unknown>} subscriber
 * @param {Record<string, Observable<unknown>>} dictionary
 * @param {(key: string, value: unknown) => void} fn
 */
export function watchAll(subscriber, dictionary, fn) {
  for (const key of Object.keys(dictionary)) {
    subscriber.add(
      dictionary[key].subscribe({
        next: (value) => fn(key, value),
      }),
    );
  }
}

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
 * Subscribes to child observables and appends them to a document fragment.
 * @param {Subscriber<unknown>} subscriber - The subscriber.
 * @param {DocumentFragment} documentFragment - The document fragment.
 * @param {Array<Observable<Node>>} children - The child observables.
 */
export function subscribeChildren(subscriber, documentFragment, children) {
  /** @type {Array<Node>} */
  const childElements = new Array(children.length).fill(null);
  for (const [index, child] of children.entries()) {
    subscriber.add(
      child.subscribe((childElement) => {
        if (!childElement) {
          if (childElements[index]) {
            const placeholder = document.createComment("PLACEHOLDER");
            childElements[index].parentNode?.replaceChild(
              placeholder,
              childElements[index],
            );
            childElements[index] = placeholder;
          }
        } else {
          if (childElements[index]) {
            if (childElement !== childElements[index]) {
              childElements[index].parentNode?.replaceChild(
                childElement,
                childElements[index],
              );
            }
          } else {
            documentFragment.appendChild(childElement);
          }
          childElements[index] = childElement;
        }
      }),
    );
  }
}

/**
 * Creates a document fragment observable from child observables.
 * @param {Array<Observable<Node>>} children - The child observables.
 * @returns {Observable<DocumentFragment>} An observable that emits a DocumentFragment.
 */
export function fragment(children) {
  return new Observable((subscriber) => {
    const documentFragment = document.createDocumentFragment();
    subscribeChildren(subscriber, documentFragment, children);
    subscriber.next(documentFragment);
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
    const documentFragment = document.createDocumentFragment();
    const listEnd = document.createComment("LIST END");
    documentFragment.appendChild(listEnd);
    /** @type {Map<T, Node>} */
    const childElements = new Map();
    /** @type {Map<T, Subscription>} */
    const childSubscriptions = new Map();
    subscriber.add(
      items.subscribe((newItems) => {
        for (let index = newItems.length - 1; index >= 0; index -= 1) {
          const item = newItems[index];
          if (!childSubscriptions.has(item)) {
            const child = renderItem(item);
            childSubscriptions.set(
              item,
              child.subscribe((newChildElement) => {
                const oldChildElement = childElements.get(item);
                if (oldChildElement) {
                  listEnd.parentNode?.replaceChild(
                    newChildElement,
                    oldChildElement,
                  );
                } else {
                  let nextChildElement;
                  let i = index + 1;
                  while (!nextChildElement && i < newItems.length) {
                    nextChildElement = childElements.get(newItems[i]);
                    i += 1;
                  }
                  if (nextChildElement) {
                    listEnd.parentNode?.insertBefore(
                      newChildElement,
                      nextChildElement,
                    );
                  } else {
                    listEnd.parentNode?.insertBefore(newChildElement, listEnd);
                  }
                }
                childElements.set(item, newChildElement);
              }),
            );
          } else {
            const childElement = childElements.get(item);
            if (childElement) {
              let nextChildElement;
              let i = index + 1;
              while (!nextChildElement && i < newItems.length) {
                nextChildElement = childElements.get(newItems[i]);
                i += 1;
              }
              if (nextChildElement) {
                if (
                  childElement &&
                  childElement.nextSibling !== nextChildElement
                ) {
                  listEnd.parentNode?.insertBefore(
                    childElement,
                    nextChildElement,
                  );
                }
              } else {
                listEnd.parentNode?.insertBefore(childElement, listEnd);
              }
            }
          }
        }
        const newItemsSet = new Set(newItems);
        for (const [item, childSubscription] of childSubscriptions.entries()) {
          if (!newItemsSet.has(item)) {
            const childElement = childElements.get(item);
            if (childElement) {
              listEnd.parentNode?.removeChild(childElement);
              childElements.delete(item);
            }
            childSubscription.unsubscribe();
            childSubscriptions.delete(item);
          }
        }
      }),
    );
    subscriber.next(documentFragment);
    return () => {
      for (const subscription of childSubscriptions.values()) {
        subscription.unsubscribe();
      }
    };
  });
}
