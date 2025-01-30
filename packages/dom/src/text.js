import { combineLatest, map, Observable } from "rxjs";
import { just } from "./core.js";

/** @import { Primitive} from "./core.js" */

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
      subscriber.add(
        value.subscribe((newValue) => {
          myTextNode.textContent = newValue;
        }),
      );
      subscriber.next(myTextNode);
    }
  });
}

/**
 * @typedef {Primitive | Observable<Primitive>} Renderable
 */

/**
 * Renders text from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {Observable<string>} An observable that emits the rendered text.
 */
export function render(strings, ...values) {
  if (values.length === 0) {
    return just(strings.join(""));
  }
  return combineLatest(
    values.map((value) => {
      if (value instanceof Observable) {
        return value.pipe(map((v) => v?.toString() ?? ""));
      }
      if (!value) {
        return just("");
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
 * Creates a text node observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...Renderable} values - The values to interpolate.
 * @returns {Observable<Text>} An observable that emits a Text node.
 */
export function text(strings, ...values) {
  return textNode(render(strings, ...values));
}
