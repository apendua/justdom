import { fromObservable, just, map, observable, Stream } from "@apendua/signal";
import { claimText } from "./hydrate.js";
import { toMountable } from "./dom.js";

/**
 * @import { Source, Subscribable } from "@apendua/signal";
 * @import { Primitive } from "./core.js";
 * @import { Mountable } from "./types.js";
 */

/**
 * Creates a text node observable.
 * @param {string | Subscribable<string>} value - The text content or an observable of text content.
 * @returns {Source<Text>} An observable that emits a Text node.
 */
export function textNode(value) {
  return new Stream((subscriber) => {
    // While hydrating, adopt the text node the server produced. Its content is
    // written anyway rather than trusted: the write costs nothing next to
    // building a node, and it quietly repairs a server/client disagreement.
    const claimed = claimText();
    if (typeof value === "string") {
      const myTextNode = claimed ?? document.createTextNode(value);
      if (claimed) {
        myTextNode.textContent = value;
      }
      subscriber.next(myTextNode);
    } else {
      const myTextNode = claimed ?? document.createTextNode("");
      subscriber.add(
        value.subscribe({
          next: (newValue) => {
            myTextNode.textContent = newValue;
          },
        }),
      );
      subscriber.next(myTextNode);
    }
  });
}

/**
 * @typedef {Primitive | Subscribable<Primitive> | (() => Primitive)} Renderable
 */

/**
 * Whether a value is a source rather than a value.
 *
 * Structural on purpose. `value instanceof Observable` was the test, and it
 * was already only accidentally right: a source this package builds is a
 * `Stream`, which is not an RxJS `Observable`, and it fell through to the
 * generic object branch below — which happened to do the same thing. What the
 * caller is allowed to pass is a `Subscribable`, so that is what gets asked.
 *
 * @param {unknown} value
 * @returns {value is Subscribable<Primitive>}
 */
function isSubscribable(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (/** @type {{ subscribe?: unknown }} */ (value).subscribe) === "function"
  );
}

/**
 * Renders text from template strings and values.
 *
 * The interpolations used to be combined with `combineLatest`, whose "wait
 * until every input has said something" is what a partially rendered template
 * needs. A derivation says the same thing for nothing: an observable input is
 * read through a node, a node with no value yet throws `NoValueError`, and an
 * effect that catches one waits — so the template renders the first time all
 * of its parts can be read, and again whenever any of them moves.
 *
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {Source<string>} An observable that emits the rendered text.
 */
export function renderText(strings, ...values) {
  if (values.length === 0) {
    return just(strings.join(""));
  }
  const parts = values.map((value) => {
    if (isSubscribable(value)) {
      const source = fromObservable(value);
      return () => source.get()?.toString() ?? "";
    }
    if (typeof value === "function") {
      return () => value() ?? "";
    }
    if (!value) {
      return () => "";
    }
    return () => value.toString();
  });
  return observable(() => {
    let rendered = "";
    strings.forEach((str, index) => {
      const part = parts[index];
      rendered += str + (part ? part() : "");
    });
    return rendered;
  });
}

/**
 * Creates a text node observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {Source<Mountable>} An observable that emits a Text node.
 */
export function text(strings, ...values) {
  return map(toMountable)(textNode(renderText(strings, ...values)));
}
