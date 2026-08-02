import * as THREE from "three";
import { Observable, switchMap, takeUntil } from "rxjs";
import { effects, just } from "@apendua/signal";
import { onInvalidate } from "@apendua/signal";
import { createPortal } from "./elements/portal.js";

/**
 * @import {MonoTypeOperatorFunction} from 'rxjs';
 * @import {Mountable} from "@apendua/justdom";
 * @import {Component,XREventMap} from './core.js';
 */

/**
 * @param {WeakKey} ctx
 * @param {Observable<Mountable<Node>>} mountable$
 * @param {MonoTypeOperatorFunction<THREE.Object3D<XREventMap>>[]} [operators]
 * @returns {Observable<Component>}
 */
export function dom(ctx, mountable$, operators = []) {
  /** @type {THREE.Group<XREventMap>} */
  const group = new THREE.Group();
  return just(group, operators).pipe(
    switchMap((obj) => {
      return new Observable((subscriber) => {
        subscriber.next({
          /** @param {THREE.Object3D} parent */
          addTo(parent) {
            const observable = mountable$.pipe(
              effects((mountable) => {
                const portal = createPortal(ctx);
                portal.addTo(obj);
                portal.mount(mountable);
                onInvalidate(() => {
                  portal.disconnect();
                });
              }),
              takeUntil(
                new Observable(() => {
                  parent.add(obj);
                  return () => {
                    if (obj.parent) {
                      obj.parent.remove(obj);
                    }
                  };
                }),
              ),
            );
            return observable.subscribe({
              error: (err) => subscriber.error(err),
            });
          },
        });
      });
    }),
  );
}
