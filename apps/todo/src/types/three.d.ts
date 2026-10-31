import type { Object3DEventMap } from "three";

declare module "three" {
  interface Object3D<TEventMap extends Object3DEventMap = Object3DEventMap> {
    __EVENT_MAP__: TEventMap;
  }
}
