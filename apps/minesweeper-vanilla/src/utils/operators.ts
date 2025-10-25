import { type Observable } from "rxjs";
import {
  set,
  setAttribute,
  effect,
  type WritableProps,
  type Primitive,
  type ObjectWithAttributes,
} from "@apendua.dev/dom";
import { $reactive, $autorun } from "@apendua.dev/signal";

export function set$<T extends object, K extends keyof WritableProps<T>>(
  key: K,
  getValue: () => T[K],
): (source: Observable<T>) => Observable<T> {
  return set(key, $reactive(getValue));
}

export function setAttribute$<T extends ObjectWithAttributes>(
  key: string,
  getValue: () => Primitive,
): (source: Observable<T>) => Observable<T> {
  return setAttribute(key, $reactive(getValue));
}

export function effect$<T>(
  fn: (value: T) => void,
): (source: Observable<T>) => Observable<T> {
  return effect((value) => $autorun(() => fn(value)));
}
