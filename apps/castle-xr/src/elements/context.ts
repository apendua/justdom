import * as THREE from "three";
import { Observable } from "rxjs";
import { createProperty } from "@apendua.dev/signal";
import { XREventMap } from "@apendua.dev/three";
import type CastleStore from "../store/CastleStore.js";
import type Session from "../store/Session.js";

export const PointersContext = createProperty(() => {
  return function <T extends THREE.Object3D<XREventMap>>(source: Observable<T>): Observable<T> {
    return source;
  };
});

export const CastleContext = createProperty<CastleStore>(() => {
  throw new Error("CastleStore not set");
});

export const SessionContext = createProperty<Session>(() => {
  throw new Error("Session not set");
});
