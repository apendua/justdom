import * as THREE from "three";
import { flatMap, just, mountEach, onCleanup, Stream } from "justdom-signal";
import { createPortal } from "./elements/portal.js";

/**
 * @import {EntityEffect, Source, Subscribable, Unsubscribable} from 'justdom-signal';
 * @import {Component,Mountable,XREventMap} from './core.js';
 * @import {PortalOptions} from './elements/portal.js';
 */

/**
 * What a portal can show: a tree that has not been put anywhere yet, which
 * the portal mounts into a container of its own, or an element the page
 * already has, which the portal mirrors where it stands.
 *
 * @typedef {Mountable | HTMLElement} DomSource
 */

/**
 * @param {DomSource | Subscribable<DomSource>} source
 * @returns {source is HTMLElement}
 */
function isElement(source) {
  return source instanceof HTMLElement;
}

/**
 * Project DOM into the scene: a `THREE.Group` carrying a panel, placed by
 * `effects` like any other object.
 *
 * `source` is what the panel shows. A justdom tree — anything with the
 * `Mountable` shape — is mounted into a hidden container the portal makes
 * for it; an `HTMLElement` the page already has is mirrored in place, with
 * the portal watching it where it is (see `PortalOptions.root` for what that
 * asks of the element). Either can arrive through a subscribable, in which
 * case each emission is a fresh portal and the previous one is taken down; a
 * bare element is the same as `just(element)`. `root` is not among the
 * options here because the source is what decides it.
 *
 * @param {WeakKey} ctx
 * @param {Subscribable<DomSource> | HTMLElement} source
 * @param {EntityEffect<THREE.Object3D<XREventMap>>[]} [effects]
 * @param {Omit<PortalOptions, "root">} [options]
 * @returns {Source<Component>}
 */
export function dom(ctx, source, effects = [], options = {}) {
  const source$ = isElement(source) ? just(source) : source;
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
          // A portal per source, switched as the tree re-renders.
          const subscription = mountEach((/** @type {DomSource} */ content) => {
            const root = isElement(content) ? content : undefined;
            const portal = createPortal(ctx, root ? { ...options, root } : options);
            portal.addTo(obj);
            if (!root) {
              portal.mount(/** @type {Mountable} */ (content));
            }
            parent.add(obj);
            onCleanup(() => {
              if (obj.parent == parent) {
                obj.parent.remove(obj);
              }
              portal.disconnect();
            });
          })(source$).subscribe({
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
