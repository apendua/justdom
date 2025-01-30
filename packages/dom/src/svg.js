import { Observable } from "rxjs";

/**
 * @template {keyof SVGElementTagNameMap} Tag
 * @param {Tag} tag
 * @returns {Observable<SVGElementTagNameMap[Tag]>}
 */
export function svg(tag) {
  return new Observable((subscriber) => {
    subscriber.next(
      document.createElementNS("http://www.w3.org/2000/svg", tag),
    );
  });
}
