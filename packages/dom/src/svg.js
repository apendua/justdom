import { just } from "./operators.js";

/**
 * @import { Observable } from 'rxjs';
 */

/**
 * @template {keyof SVGElementTagNameMap} Tag
 * @param {Tag} tag
 * @returns {Observable<SVGElementTagNameMap[Tag]>}
 */
export function svg(tag) {
  return just(document.createElementNS("http://www.w3.org/2000/svg", tag));
}
