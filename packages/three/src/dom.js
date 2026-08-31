import * as THREE from "three";
import { flatMap, just, mountEach, onCleanup, Stream } from "@apendua/signal";
import { createPortal } from "./elements/portal.js";

/**
 * @import {EntityEffect, Source, Subscribable, Unsubscribable} from '@apendua/signal';
 * @import {Component,Mountable,XREventMap} from './core.js';
 * @import {PortalOptions} from './elements/portal.js';
 */

/**
 * @param {WeakKey} ctx
 * @param {Subscribable<Mountable>} mountable$
 * @param {EntityEffect<THREE.Object3D<XREventMap>>[]} [effects]
 * @param {PortalOptions} [options]
 * @returns {Source<Component>}
 */
export function dom(ctx, mountable$, effects = [], options = {}) {
  /** @type {THREE.Group<XREventMap>} */
  const group = new THREE.Group();
  return flatMap((/** @type {THREE.Group<XREventMap>} */ obj) => {
    return new Stream((subscriber) => {
      // Whatever `addTo` has handed out and nobody has given back. This used
      // to be a `Subject` and a `takeUntil` on it: a notifier fired from the
      // teardown so that a mounting the caller was still holding stopped
      // anyway. Holding the subscriptions says the same thing without a
      // stream in the middle — the teardown simply unsubscribes them.
      /** @type {Set<Unsubscribable>} */
      const mountings = new Set();
      subscriber.next({
        /** @param {THREE.Object3D} parent */
        addTo(parent) {
          // An effect per mountable, switched as the tree re-renders.
          const subscription = mountEach((/** @type {Mountable} */ mountable) => {
            const portal = createPortal(ctx, options);
            portal.addTo(obj);
            portal.mount(mountable);
            parent.add(obj);
            onCleanup(() => {
              if (obj.parent == parent) {
                obj.parent.remove(obj);
              }
              portal.disconnect();
            });
          })(mountable$).subscribe({
            error: (err) => subscriber.error(err),
          });
          mountings.add(subscription);
          return () => {
            mountings.delete(subscription);
            subscription.unsubscribe();
          };
        },
      });
      return () => {
        for (const mounting of mountings) {
          mounting.unsubscribe();
        }
        mountings.clear();
      };
    });
  })(just(group, effects));
}
