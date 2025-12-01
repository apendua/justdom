import { type Observable } from "rxjs";
import { setAttribute, type Primitive, type ObjectWithAttributes } from "@apendua.dev/dom";
import { observable } from "@apendua.dev/reactive";

export function setAttribute$<T extends ObjectWithAttributes>(
  key: string,
  getValue: () => Primitive,
): (source: Observable<T>) => Observable<T> {
  return setAttribute(key, observable(getValue));
}
