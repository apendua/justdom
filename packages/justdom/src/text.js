import { combineLatest, map, Observable } from "rxjs";
import { rx } from "@apendua/signal/rxjs";
import { observable, just } from "@apendua/signal";
import { claimText } from "./hydrate.js";
import { toMountable } from "./dom.js";

/**
 * @import { Primitive } from "./core.js";
 * @import { Mountable } from "./types.js";
 */

/**
 * Creates a text node observable.
 * @param {string | import("@apendua/signal").Subscribable<string>} value - The text content or an observable of text content.
 * @returns {Observable<Text>} An observable that emits a Text node.
 */
export function textNode(value) {
  return new Observable((subscriber) => {
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
 * @typedef {Primitive | import("@apendua/signal").Subscribable<Primitive> | (() => Primitive)} Renderable
 */

/**
 * Renders text from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {import("@apendua/signal").Source<string>} An observable that emits the rendered text.
 */
export function renderText(strings, ...values) {
  if (values.length === 0) {
    return just(strings.join(""));
  }
  return combineLatest(
    values.map((value) => {
      if (value instanceof Observable) {
        return value.pipe(map((/** @type {Primitive} */ v) => v?.toString() ?? ""));
      }
      if (typeof value === "function") {
        return rx(observable(() => value() ?? ""));
      }
      if (!value) {
        return rx(just(""));
      }
      if (typeof value === "object") {
        // A `Subscribable` that is not an RxJS observable — carried across.
        return rx(value).pipe(map((v) => v?.toString() ?? ""));
      }
      return rx(just(value.toString()));
    }),
  ).pipe(
    map((observedValues) => {
      let rendered = "";
      strings.forEach((str, index) => {
        rendered += str + (observedValues[index] ?? "");
      });
      return rendered;
    }),
  );
}

/**
 * Creates a text node observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {import("@apendua/signal").Source<Mountable>} An observable that emits a Text node.
 */
export function text(strings, ...values) {
  return textNode(renderText(strings, ...values)).pipe(map(toMountable));
}
