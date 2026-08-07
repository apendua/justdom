import * as THREE from "three";
import { effects, just, fromEvent, observable, use } from "@apendua/signal";
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
 * An effect that waits for the object to take its place in a scene, so that
 * whatever it reads off the object — a world matrix, most of the time — is a
 * real answer rather than the one an orphan gives.
 *
 * It waits for that once. Being moved to another parent afterwards does not
 * run it again: `Object3D.attach` keeps the object exactly where it was in the
 * room, so nothing an effect here could have read has changed, and the
 * detached instant in the middle of a re-parent is an artefact of how three
 * splices the graph rather than a moment the object was ever out of the scene.
 * Reacting to it would tear down and rebuild everything under whatever was
 * picked up — which, for a physics body, is the whole simulation.
 *
 * @template {Object3D<any>} T
 * @param {(obj: T) => void} fn
 * @returns {MonoTypeOperatorFunction<T>}
 */
export function layoutEffects(fn) {
  /**
   * @param {Object3D<THREE.Object3DEventMap>} obj
   * @returns {boolean}
   */
  function isInScene(obj) {
    addDependency(fromEvent(obj, "added"));
    addDependency(fromEvent(obj, "removed"));
    if (!obj.parent) {
      return false;
    }
    if (obj.parent instanceof THREE.Scene) {
      return true;
    }
    return isInScene(obj.parent);
  }

  return effects((obj) => {
    // Latched rather than filtered: once it has read true the getter stops
    // looking at the graph at all, which drops the listeners on every ancestor
    // along with it.
    let attached = false;
    use(
      observable(() => attached || isInScene(obj)).pipe(
        distinctUntilChanged(),
        effects((inScene) => {
          if (!inScene) {
            return;
          }
          attached = true;
          fn(obj);
        }),
      ),
    );
  });
}
