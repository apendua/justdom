import { type Observable } from "rxjs";
import {
  set,
  attr,
  effect,
  type WritableProps,
  type Primitive,
  type ObjectWithAttributes,
} from "@apendua.dev/dom";
import { $evaluate, $run } from "@apendua.dev/store4";

export function set$<T extends object, K extends keyof WritableProps<T>>(
  key: K,
  getValue: () => T[K],
): (source: Observable<T>) => Observable<T> {
  return set(key, $evaluate(getValue));
}

export function attr$<T extends ObjectWithAttributes>(
  key: string,
  getValue: () => Primitive,
): (source: Observable<T>) => Observable<T> {
  return attr(key, $evaluate(getValue));
}

export function effect$<T>(
  fn: (value: T) => void,
): (source: Observable<T>) => Observable<T> {
  return effect((value) => $run(() => fn(value)));
}
