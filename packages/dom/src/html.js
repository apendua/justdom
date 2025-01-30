import { Observable } from "rxjs";

/**
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @returns {Observable<HTMLElementTagNameMap[Tag]>}
 */
export function html(tag) {
  return new Observable((subscriber) => {
    subscriber.next(document.createElement(tag));
  });
}
