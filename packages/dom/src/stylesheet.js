import { Observable } from "rxjs";
import { render } from "./text.js";
import { shared } from "./core.js";

/**
 * Creates a class name observable.
 * @param {Observable<string>} value - An observable of CSS class content.
 * @returns {Observable<string>}
 */
export function styleElement(value) {
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
 * Creates a CSS class name observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...import("./text.js").Renderable} values - The values to interpolate.
 * @returns {Observable<string>}
 */
export function stylesheet(strings, ...values) {
  return styleElement(render(strings, ...values)).pipe(shared());
}
