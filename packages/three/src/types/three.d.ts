import type { Object3DEventMap, WebXRManagerEventMap } from "three";

declare module "three" {
  interface Object3D<TEventMap extends Object3DEventMap = Object3DEventMap> {
    __EVENT_MAP__: TEventMap;
  }

  interface WebXRManager<TEventMap extends WebXRManagerEventMap = WebXRManagerEventMap> {
    __EVENT_MAP__: TEventMap;
  }
}

export {};
