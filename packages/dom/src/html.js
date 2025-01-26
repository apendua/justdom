import { just } from "./operators.js";

/**
 * @import { Observable } from 'rxjs';
 */

/**
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @returns {Observable<HTMLElementTagNameMap[Tag]>}
 */
export function html(tag) {
  return just(document.createElement(tag));
}
