import * as THREE from "three";
import { Derived, each, flatMap, fromEvent, just, Stream, use, useEffect } from "@apendua/signal";
import { addDependency } from "@apendua/signal";

/**
 * @import { EntityEffect, Subscribable, Source } from '@apendua/signal';
 * @import { Object3D } from 'three';
 * @import { CopyableProps, Component } from './core.js';
 */

/**
 * @template {object} TEntity
 * @template {keyof CopyableProps<TEntity>} K
 * @param {K} key
 * @param {Subscribable<TEntity[K]>} value
 * @returns {EntityEffect<TEntity>}
 */
export function copy(key, value) {
  // Held, not chosen: the source is fixed for the life of the mounting and
  // nothing reads its values back, which is the case `use` is for — one
  // dependency edge instead of a `Derived`, an inner effect and a switch.
  return (entity) => {
    use(
      each(value, (v) => {
        /** @type {Record<K, { copy: (v: TEntity[K]) => void }>} */ (entity)[key].copy(v);
      }),
    );
  };
}

/**
 * @param {() => () => void} fn
 * @returns {Source<never>}
 */
function teardown(fn) {
  return new Stream(() => fn());
}

/**
 * @param {Object3D<any>} parent
 * @param {Subscribable<Component>} child
 * @return {Source<never>}
 */
function addToParent(parent, child) {
  // No `distinctUntilChanged` in front of this: a node-backed child already
  // stops at the value it was holding, and every other one hands back a
  // component object built afresh per emission, which no comparison collapses.
  return flatMap((/** @type {Component} */ component) => teardown(() => component.addTo(parent)))(
    child,
  );
}

/**
 * @template {Object3D<any>} TEntity
 * @param {Subscribable<Component>[]} observables
 * @returns {EntityEffect<TEntity>}
 */
export function children(...observables) {
  // One edge per child rather than one over a `merge` of them all, so a child
  // that fails does so as itself rather than as an anonymous branch of a
  // merged stream.
  //
  // Held, not chosen: `use` is handed a source that is fixed for the life of
  // the mounting. Switching a subtree happens *inside* that source — the
  // `flatMap` above is `onEachValue`, which unsubscribes the component it is
  // holding before it subscribes the next one — so the vacate-before-claim a
  // parent slot needs is the stream's, not the holder's. Holding it through
  // an effect that re-chooses it would buy a `Derived` and an `Effect` per
  // child to re-choose a source that cannot change.
  const mountings = observables.map((observable) => (/** @type {TEntity} */ entity) => {
    use(addToParent(entity, observable));
  });
  return (entity) => {
    for (const mount of mountings) {
      mount(entity);
    }
  };
}

/**
 * @param {Subscribable<Component>[]} observables
 * @returns {Source<Component>}
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
 * @returns {(source: Subscribable<Object3D | null>) => Source<Component>}
 */
function toComponent() {
  return (source) => {
    return new Stream((subscriber) => {
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
  return toComponent()(just(null));
}

/**
 * @template {Object3D<any>} T
 * @param {T} object
 * @param {Array<EntityEffect<T>>} [effects]
 * @returns {Source<Component>}
 */
export function $(object, effects = []) {
  return toComponent()(just(object, effects));
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
 * @returns {EntityEffect<T>}
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

  return (obj) => {
    // Latched rather than filtered: once it has read true the derivation stops
    // looking at the graph at all, which drops the listeners on every ancestor
    // along with it. The `Derived` is also the cutoff that used to be a
    // `distinctUntilChanged`. State lives here, in the mounting, so the inner
    // effect can re-run without resetting it.
    let attached = false;
    const inScene = new Derived(() => attached || isInScene(obj));
    useEffect(
      () => {
        if (!inScene.get()) {
          return;
        }
        attached = true;
        fn(obj);
      },
      { name: "layoutEffects" },
    );
  };
}
