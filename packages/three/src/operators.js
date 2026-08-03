import * as THREE from "three";
import { effects, just, fromEvent } from "@apendua/signal";
import { distinctUntilChanged, Observable, switchMap } from "rxjs";
import { addDependency } from "@apendua/signal";

/**
 * @import { MonoTypeOperatorFunction, Subscriber } from 'rxjs';
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
 * @param {() => () => void} fn
 * @returns {Observable<never>}
 */
function teardown(fn) {
  return new Observable(() => fn());
}

/**
 * @param {Object3D<any>} parent
 * @param {Observable<Component>} child
 * @return {Observable<never>}
 */
function addToParent(parent, child) {
  return child.pipe(
    distinctUntilChanged(),
    switchMap((component) => {
      return teardown(() => component.addTo(parent));
    }),
  );
}

/**
 * @template {Object3D<any>} TEntity
 * @param {Observable<Component>[]} observables
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function children(...observables) {
  return switchMap((entity) => {
    return new Observable((/** @type {Subscriber<TEntity>} */ subscriber) => {
      observables.forEach((observable) => {
        subscriber.add(addToParent(entity, observable).subscribe());
      });
      subscriber.next(entity);
    });
  });
}

/**
 * @param {Observable<Component>[]} observables
 * @returns {Observable<Component>}
 */
export function fragment(...observables) {
  return just({
    addTo: (parent) => {
      const subscriptions = observables.map((observable) =>
        addToParent(parent, observable).subscribe(),
      );
      return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
    },
  });
}

/**
 * @returns {(source: Observable<Object3D | null>) => Observable<Component>}
 */
function toComponent() {
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
 * @template {Object3D<any>} T
 * @param {T} object
 * @param {Array<(source: Observable<T>) => Observable<T>>} [operators]
 * @returns {Observable<Component>}
 */
export function $(object, operators = []) {
  return just(object, operators).pipe(toComponent());
}

/**
 * @template {Object3D<any>} T
 * @param {(obj: T) => void} fn
 * @returns {MonoTypeOperatorFunction<T>}
 */
export function layoutEffects(fn) {
  /**
   * @template {Object3D<THREE.Object3DEventMap>} T
   * @param {T} obj
   * @param {() => void} fn
   * @returns {void}
   */
  function useWhenAttachedToScene(obj, fn) {
    addDependency(fromEvent(obj, "added"));
    addDependency(fromEvent(obj, "removed"));
    if (!obj.parent) {
      return;
    }
    if (obj.parent instanceof THREE.Scene) {
      fn();
      return;
    }
    return useWhenAttachedToScene(obj.parent, fn);
  }

  return effects((obj) => {
    useWhenAttachedToScene(obj, () => fn(obj));
  });
}
