import * as THREE from "three";
import { Observable, Subject, switchMap, takeUntil } from "rxjs";
import { effects, just } from "justdom-signal";
import { onCleanup } from "justdom-signal";
import { createPortal } from "./elements/portal.js";

/**
 * @import {MonoTypeOperatorFunction} from 'rxjs';
 * @import {Component,Mountable,XREventMap} from './core.js';
 * @import {PortalOptions} from './elements/portal.js';
 */

/**
 * @param {WeakKey} ctx
 * @param {Observable<Mountable>} mountable$
 * @param {MonoTypeOperatorFunction<THREE.Object3D<XREventMap>>[]} [operators]
 * @param {PortalOptions} [options]
 * @returns {Observable<Component>}
 */
export function dom(ctx, mountable$, operators = [], options = {}) {
  /** @type {THREE.Group<XREventMap>} */
  const group = new THREE.Group();
  return just(group, operators).pipe(
    switchMap((obj) => {
      return new Observable((subscriber) => {
        /** @type {Subject<void>} */
        const done = new Subject();
        subscriber.next({
          /** @param {THREE.Object3D} parent */
          addTo(parent) {
            const observable = mountable$.pipe(
              effects((mountable) => {
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
