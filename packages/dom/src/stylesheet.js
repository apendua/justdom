import { Observable, ReplaySubject, share } from "rxjs";
import { renderText } from "./text.js";

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
  return styleElement(renderText(strings, ...values)).pipe(
    share({
      connector: () => new ReplaySubject(1),
      resetOnRefCountZero: true,
    }),
  );
}

/**
 * @param {string} fontUrl
 * @param {object} [options]
 * @param {string} [options.format]
 * @param {string} [options.fontWeight]
 * @param {string} [options.fontStyle]
 * @returns {Observable<string>}
 */
export function fontFace(fontUrl, options = {}) {
  const { format = "truetype", fontWeight = "normal", fontStyle = "normal" } = options;
  return new Observable((subscriber) => {
    const styleElement = document.createElement("style");
    const fontName = `font_${Math.random().toString(36).slice(2)}`;
    styleElement.innerHTML = `
      @font-face {
        font-family: ${fontName};
        src: url('${fontUrl}') format('${format}');
        font-weight: ${fontWeight};
        font-style: ${fontStyle};
      }
    `;
    document.head.appendChild(styleElement);
    subscriber.next(fontName);
    return () => {
      document.head.removeChild(styleElement);
    };
  }).pipe(
    share({
      connector: () => new ReplaySubject(1),
      resetOnRefCountZero: true,
    }),
  );
}
