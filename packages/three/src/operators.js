import { just } from "@apendua.dev/reactive";
import { distinctUntilChanged, Observable, switchMap } from "rxjs";

/**
 * @import { Object3D } from 'three';
 * @import { CopyableProps, Component } from './core.js';
 */

/**
 * @template {object} TEntity
 * @template {keyof CopyableProps<TEntity>} K
 * @param {K} key
 * @param {Observable<TEntity[K]>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function copy(key, value) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(
            value.subscribe({
              next: (v) => {
                /** @type {Record<K, { copy: (v: TEntity[K]) => void }>} */ (entity)[key].copy(v);
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
 *
 * @param {Object3D<any>} parent
 * @param {Observable<Component>} child
 */
function addToParent(parent, child) {
  return child.pipe(
    distinctUntilChanged(),
    switchMap((component) => {
      return new Observable(() => {
        return component.addTo(parent);
      });
    }),
  );
}

/**
 * @template {Object3D<any>} TEntity
 * @param {Observable<Component>[]} children
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function add(...children) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          children.forEach((child) => {
            subscriber.add(addToParent(entity, child).subscribe());
          });
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @returns {(source: Observable<Object3D | null>) => Observable<Component>}
 */
export function toComponent() {
  return (source) => {
    return new Observable((subscriber) => {
      subscriber.add(
        source.subscribe({
          next: (entity) => {
            if (!entity) {
              subscriber.next({
                addTo: () => () => {},
              });
            } else {
              subscriber.next({
                addTo: (parent) => {
                  parent.add(entity);
                  return () => {
                    parent.remove(entity);
                  };
                },
              });
            }
          },
        }),
      );
    });
  };
}

export function Nothing() {
  return just(null).pipe(toComponent());
}

/**
 * @template {Object3D} T
 * @param {T} object
 * @param {Array<(source: Observable<T>) => Observable<T>>} [operators]
 * @returns {Observable<Component>}
 */
export function $(object, operators = []) {
  return just(object, operators).pipe(toComponent());
}
