import { Observable } from "rxjs";
import { subscribeChildren, watchAll } from "./core.js";

/**
 * @import { Object3D, Object3DEventMap } from 'three';
 */

/**
 * @import { WritableProps, CopyableProps } from './core.js';
 */

/**
 * @typedef {{
 *   [E in keyof Object3DEventMap]?: (e: Object3DEventMap[E]) => void;
 * }} EventHandlers
 */

/**
 * @template {Object3D} Entity
 * @template {unknown[]} Args
 */
export class ThreeBuilder {
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  #properties;
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  #copy;
  /** @type {EventHandlers} */
  #handlers;
  /** @type {Array<Observable<Object3D>>} */
  #children;
  /** @type {Array<(e: Entity) => Observable<void>>} */
  #effects;
  /** @type {Array<(e: Entity) => void>} */
  #initializers;
  /** @type {(...args: Args) => Entity} */
  #factory;

  /**
   * @param {new (...args: Args) => Entity} constructor
   */
  constructor(constructor) {
    this.#properties = {};
    this.#copy = {};
    this.#handlers = {};
    this.#children = [];
    this.#effects = [];
    this.#initializers = [];
    this.#factory = (...args) => new constructor(...args);
  }

  /**
   * @param  {Args} args
   * @returns {Observable<Entity>}
   */
  get(...args) {
    return new Observable((subscriber) => {
      const entity = this.#factory(...args);
      for (const fn of this.#initializers) {
        fn(entity);
      }
      watchAll(subscriber, this.#properties, (key, value) => {
        /** @type {any} */ (entity)[key] = value;
      });
      watchAll(subscriber, this.#copy, (key, value) => {
        /** @type {any} */ (entity)[key].copy(value);
      });
      for (const [key, value] of Object.entries(this.#handlers)) {
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
      for (const fn of this.#effects) {
        subscriber.add(fn(entity).subscribe());
      }
      if (this.#children.length > 0) {
        subscribeChildren(subscriber, entity, this.#children);
      }
      subscriber.next(entity);
    });
  }

  /**
   * @template {keyof WritableProps<Entity>} K
   * @param {K} key
   * @param {Observable<WritableProps<Entity>[K]>} value
   */
  set(key, value) {
    this.#properties[key] = value;
    return this;
  }

  /**
   * @template {keyof CopyableProps<Entity>} K
   * @param {K} key
   * @param {Observable<CopyableProps<Entity>[K]>} value
   * @returns {this}
   */
  copy(key, value) {
    this.#copy[key] = value;
    return this;
  }

  /**
   * @param {(e: Entity) => void} fn
   * @returns {this}
   */
  init(fn) {
    this.#initializers.push(fn);
    return this;
  }

  /**
   * @param {(e: Entity) => Observable<void>} fn
   * @returns {this}
   */
  effect(fn) {
    this.#effects.push(fn);
    return this;
  }

  /**
   * @template {keyof EventHandlers} K
   * @param {K} key
   * @param {EventHandlers[K]} value
   * @returns {this}
   */
  on(key, value) {
    this.#handlers[key] = value;
    return this;
  }

  /**
   * @param {Observable<Object3D>[]} entities
   * @returns {this}
   */
  add(...entities) {
    this.#children.push(...entities);
    return this;
  }
}

/**
 * @template {Object3D} Entity
 * @template {unknown[]} Args
 * @param {new (...args: Args) => Entity} constructor
 */
export function $(constructor) {
  return new ThreeBuilder(constructor);
}
