import * as THREE from "three";
import { Observable, Subject, switchMap, takeUntil } from "rxjs";
import { just, rxEffects } from "@apendua/signal";
import { onCleanup } from "@apendua/signal";
import { createPortal } from "./elements/portal.js";

/**
 * @import {EntityEffect} from '@apendua/signal';
 * @import {Component,Mountable,XREventMap} from './core.js';
 * @import {PortalOptions} from './elements/portal.js';
 */

/**
 * @param {WeakKey} ctx
 * @param {Observable<Mountable>} mountable$
 * @param {EntityEffect<THREE.Object3D<XREventMap>>[]} [effects]
 * @param {PortalOptions} [options]
 * @returns {Observable<Component>}
 */
export function dom(ctx, mountable$, effects = [], options = {}) {
  /** @type {THREE.Group<XREventMap>} */
  const group = new THREE.Group();
  return just(group, effects).pipe(
    switchMap((obj) => {
      return new Observable((subscriber) => {
        /** @type {Subject<void>} */
        const done = new Subject();
        subscriber.next({
          /** @param {THREE.Object3D} parent */
          addTo(parent) {
            // An effect per mountable, switched as the tree re-renders.
            const observable = mountable$.pipe(
              rxEffects((mountable) => {
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
              }),
              takeUntil(done),
            );
            return observable.subscribe({
              error: (err) => subscriber.error(err),
            });
          },
        });
        return () => {
          done.next();
        };
      });
    }),
  );
}
