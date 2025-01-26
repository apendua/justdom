import {
  distinctUntilChanged,
  Observable,
  ReplaySubject,
  share,
  switchMap,
} from "rxjs";
import { removeSegment, replaceSegment, toSegment } from "./helpers.js";

/**
 * @import { WritableProps, EventListener, Primitive } from './core.js';
 */

/**
 * @template {HTMLElement} TElement1
 * @template {keyof HTMLElementEventMap} T
 * @overload
 * @param {T} type
 * @param {(e: HTMLElementEventMap[T]) => void} handler
 * @returns {(source: Observable<TElement1>) => Observable<TElement1>}
 */

/**
 * @template {SVGElement} TElement2
 * @template {keyof SVGElementEventMap} T
 * @overload
 * @param {T} type
 * @param {(e: SVGElementEventMap[T]) => void} handler
 * @returns {(source: Observable<TElement2>) => Observable<TElement2>}
 */

/**
 * @template {EventListener<Record<string, unknown>>} TElement3
 * @param {string} type
 * @param {(e: unknown) => void} handler
 * @returns {(source: Observable<TElement3>) => Observable<TElement3>}
 */
export function on(type, handler) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          entity.addEventListener(type, handler);
          subscriber.next(entity);
          return () => {
            entity.removeEventListener(type, handler);
          };
        });
      }),
    );
  };
}

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 * @param {K} key
 * @param {Observable<TEntity[K]>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}   *
 */
export function set(key, value) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(
            value.subscribe({
              next: (v) => {
                entity[key] = v;
              },
            }),
          );
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @typedef {object} ObjectWithAttributes
 * @property {(key: string, value: string) => void} setAttribute
 * @property {(key: string) => void} removeAttribute
 */

/**
 * @template {ObjectWithAttributes} TEntity
 * @template {string} K
 * @param {K} key
 * @param {Observable<Primitive>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function attr(key, value) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(
            value.subscribe({
              next: (v) => {
                if (v === null || v === undefined) {
                  entity.removeAttribute(key);
                } else {
                  entity.setAttribute(key, v.toString());
                }
              },
            }),
          );
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @typedef {object} ObjectWithData
 * @property {Record<string, string>} dataset
 */

/**
 * @template {ObjectWithData} TEntity
 * @param {string} key
 * @param {Observable<Primitive>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function data(key, value) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(
            value.subscribe({
              next: (v) => {
                if (v === null || v === undefined) {
                  delete entity.dataset[key];
                } else {
                  entity.dataset[key] = v.toString();
                }
              },
            }),
          );
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @typedef {object} ObjectWithStyle
 * @property {CSSStyleDeclaration} style
 */

/**
 * @template {ObjectWithStyle} TEntity
 * @template {keyof WritableProps<CSSStyleDeclaration>} K
 * @param {K} key
 * @param {Observable<CSSStyleDeclaration[K]>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function style(key, value) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(
            value.subscribe({
              next: (v) => {
                if (v === null || v === undefined) {
                  delete entity.style[key];
                } else {
                  entity.style[key] = v;
                }
              },
            }),
          );
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @template {Element} TElement
 * @param {Observable<Node | null>[]} children
 * @returns {(source: Observable<TElement>) => Observable<TElement>}
 */
export function append(...children) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          /** @type {Map<number, [Node, Node]>} */
          const segments = new Map();
          const fragment = document.createDocumentFragment();

          for (let i = 0; i < children.length; i++) {
            const node = fragment.appendChild(document.createComment(""));
            segments.set(i, toSegment(node));
          }

          children.forEach((child, i) => {
            subscriber.add(
              child.pipe(distinctUntilChanged()).subscribe({
                next: (newElement) => {
                  const oldSegment = segments.get(i);
                  if (oldSegment) {
                    segments.set(i, replaceSegment(newElement, oldSegment));
                  }
                },
                complete: () => {
                  const oldSegment = segments.get(i);
                  if (oldSegment) {
                    removeSegment(oldSegment);
                    segments.delete(i);
                  }
                },
              }),
            );
          });

          entity.appendChild(fragment);
          subscriber.next(entity);
          return () => {
            for (const segment of segments.values()) {
              removeSegment(segment);
            }
          };
        });
      }),
    );
  };
}

/**
 * @template T
 * @param {(entity: T) => Observable<never>} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effect(fn) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(fn(entity).subscribe());
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @template T
 * @param {T} value
 * @returns {Observable<T>}
 */
export function just(value) {
  return new Observable((subscriber) => {
    subscriber.next(value);
  });
}

/**
 * @template T
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function sharedResource() {
  return share({
    connector: () => new ReplaySubject(1),
  });
}
