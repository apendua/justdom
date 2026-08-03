import * as THREE from "three";
import { Observable } from "rxjs";
import { createProperty } from "@apendua.dev/signal";
import { XREventMap } from "@apendua.dev/three";

/**
 * Wired up in `App.ts` to record where each controller's ray lands, so the dot
 * under the pointer can be drawn. Anything pointable opts in by piping through
 * it.
 */
export const PointersContext = createProperty(() => {
  return function <T extends THREE.Object3D<XREventMap>>(source: Observable<T>): Observable<T> {
    return source;
  };
});
