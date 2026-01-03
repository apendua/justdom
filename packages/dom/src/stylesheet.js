import { map, Observable, ReplaySubject, share } from "rxjs";
import { renderText } from "./text.js";
import { effectMap } from "@apendua.dev/reactive";

/** @type {Observable<string>} */
export const CLASS_NAME = new Observable();

/**
 * Creates a class name observable.
 * @param {Observable<string>} value - An observable of CSS class content.
 * @returns {Observable<string>}
 */
function styleElement(value) {
  return new Observable((subscriber) => {
    const styleElement = document.createElement("style");
    subscriber.add(
      value.subscribe((newValue) => {
        styleElement.innerHTML = newValue;
      }),
    );
    document.head.appendChild(styleElement);
    return () => {
      document.head.removeChild(styleElement);
    };
  });
}

/**
 * @param {string} prefix
 * @returns {Observable<string>}
 */
function randomString(prefix) {
  return new Observable((subscriber) => {
    const key = `${prefix}${Math.random().toString(36).slice(2)}`;
    subscriber.next(key);
  }).pipe(
    share({
      connector: () => new ReplaySubject(1),
      resetOnRefCountZero: true,
    }),
  );
}

/**
 * Creates a CSS class name observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...import("./text.js").Renderable} values - The values to interpolate.
 * @returns {Observable<string>}
 */
export function className(strings, ...values) {
  return randomString("class_").pipe(
    effectMap((key) => {
      return styleElement(
        renderText(strings, ...values).pipe(map((value) => `.${key} {${value}}`)),
      );
    }),
    share({
      connector: () => new ReplaySubject(1),
      resetOnRefCountZero: true,
    }),
  );
}

/**
 * Creates a CSS class name observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...import("./text.js").Renderable} values - The values to interpolate.
 * @returns {Observable<string>}
 */
export function stylesheet(strings, ...values) {
  const className$ = randomString("class_");
  return className$.pipe(
    effectMap(() => {
      return styleElement(
        renderText(
          strings,
          ...values.map((value) => {
            if (value === CLASS_NAME) {
              return className$;
            }
            return value;
          }),
        ),
      );
    }),
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
