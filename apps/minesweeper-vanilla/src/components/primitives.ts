import {
  SVGBuilder,
  HTMLBuilder,
  type Primitive,
  type WritableProps,
} from "@apendua.dev/dom";
import { $evaluate } from "@apendua.dev/store4";

class ReactiveHTMLBuilder<
  T extends keyof HTMLElementTagNameMap,
> extends HTMLBuilder<T> {
  set$<K extends keyof WritableProps<HTMLElementTagNameMap>>(
    key: K,
    getValue: () => HTMLElementTagNameMap[keyof HTMLElementTagNameMap][K],
  ) {
    return this.set(key, $evaluate(getValue));
  }

  setAttribute$(name: string, getValue: () => Primitive) {
    return this.setAttribute(name, $evaluate(getValue));
  }
}

export function html<T extends keyof HTMLElementTagNameMap>(tag: T) {
  return new ReactiveHTMLBuilder(tag);
}

class ReactiveSVGBuilder<
  T extends keyof SVGElementTagNameMap,
> extends SVGBuilder<T> {
  set$<K extends keyof WritableProps<SVGElementTagNameMap>>(
    key: K,
    getValue: () => SVGElementTagNameMap[keyof SVGElementTagNameMap][K],
  ) {
    return this.set(key, $evaluate(getValue));
  }
  setAttribute$(name: string, getValue: () => Primitive) {
    return this.setAttribute(name, $evaluate(getValue));
  }
}

export function svg<T extends keyof SVGElementTagNameMap>(tag: T) {
  return new ReactiveSVGBuilder(tag);
}
