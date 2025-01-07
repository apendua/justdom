import * as THREE from "three";
import { Observable } from "rxjs";
import { subscribeChildren, watchAll } from "./core.js";

/**
 * @import { WritableProps, CopyableProps } from './core.js';
 */

/**
 * @typedef {{
 *   [E in keyof THREE.Object3DEventMap]?: (e: THREE.Object3DEventMap[E]) => void;
 * }} EventHandlers
 */

const constructors = {
  object3d: () => new THREE.Object3D(),
  /**
   * @param {ConstructorParameters<typeof THREE.Mesh>} args
   */
  mesh: (...args) => new THREE.Mesh(...args),
  group: () => new THREE.Group(),
  scene: () => new THREE.Scene(),
};

/**
 * @typedef {typeof constructors} Constructors
 */

/**
 * @typedef {{
 *   [P in keyof Constructors]: ReturnType<Constructors[P]>
 * }} Entities
 */

/**
 * @template {keyof Entities} EntityType
 * @param {EntityType} entityType
 */
export function build(entityType) {
  /**
   * @typedef {Entities[EntityType]} Entity
   */
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  const properties = {};
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  const copy = {};
  /** @type {EventHandlers} */
  const handlers = {};
  /** @type {Array<Observable<THREE.Object3D>>} */
  const children = [];
  /** @type {Array<(e: Entity) => Observable<void>>} */
  const effects = [];
  /** @type {Array<(e: Entity) => void>} */
  const initializers = [];
  const factory = /** @type {(...args: unknown[]) => Entity} */ (
    constructors[entityType]
  );
  const builder = {
    /**
     * @param  {Parameters<Constructors[EntityType]>} args
     * @returns {Observable<Entity>}
     */
    get: (...args) => {
      return new Observable((subscriber) => {
        const entity = factory(...args);
        for (const fn of initializers) {
          fn(entity);
        }
        watchAll(subscriber, properties, (key, value) => {
          /** @type {any} */ (entity)[key] = value;
        });
        watchAll(subscriber, copy, (key, value) => {
          /** @type {any} */ (entity)[key].copy(value);
        });
        for (const [key, value] of Object.entries(handlers)) {
          const eventName = /** @type {keyof EventHandlers} */ (key);
          const eventHandler = /** @type {(e: unknown) => void} */ (value);
          subscriber.add(
            new Observable(() => {
              entity.addEventListener(eventName, eventHandler);
              return () => {
                entity.removeEventListener(eventName, eventHandler);
              };
            }).subscribe(),
          );
        }
        for (const fn of effects) {
          subscriber.add(fn(entity).subscribe());
        }
        if (children && children.length > 0) {
          subscribeChildren(subscriber, entity, children);
        }
        subscriber.next(entity);
      });
    },
    /**
     * @template {keyof WritableProps<Entity>} K
     * @param {K} key
     * @param {Observable<WritableProps<Entity>[K]>} value
     */
    set: (key, value) => {
      properties[key] = value;
      return builder;
    },
    /**
     * @template {keyof CopyableProps<Entity>} K
     * @param {K} key
     * @param {Observable<Entity[K]>} value
     */
    copy: (key, value) => {
      copy[key] = value;
      return builder;
    },
    /**
     * @param {(e: Entity) => void} fn
     */
    init: (fn) => {
      initializers.push(fn);
      return builder;
    },
    /**
     * @param {(e: Entity) => Observable<void>} fn
     */
    effect: (fn) => {
      effects.push(fn);
      return builder;
    },
    /**
     * @template {keyof EventHandlers} K
     * @param {K} key
     * @param {EventHandlers[K]} value
     */
    on: (key, value) => {
      handlers[key] = value;
      return builder;
    },
    /**
     * @param {Observable<Entity>[]} entities
     */
    add: (...entities) => {
      children.push(...entities);
      return builder;
    },
  };
  return builder;
}
