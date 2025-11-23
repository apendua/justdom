import { distinctUntilChanged, Observable, switchMap, tap } from "rxjs";

/**
 * @import { Object3D } from 'three';
 * @import { WritableProps, CopyableProps, XREventMap, Component, EventListener } from './core.js';
 */

/**
 * @template {EventListener<XREventMap>} TEntity
 * @template {keyof XREventMap} T
 * @param {T} type
 * @param {(e: XREventMap[T]) => void} handler
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function on(type, handler) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          entity.addEventListener(type, handler);
          subscriber.next(entity);
          return () => {
            entity.removeEventListener(type, handler);
          };
        });
      }),
    );
  };
}

/**
 * @template {object} TEntity
 * @param {Partial<WritableProps<TEntity>>} props
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}   *
 */
export function init(props) {
  return (source) => {
    return source.pipe(
      tap((entity) => {
        Object.assign(entity, props);
      }),
    );
  };
}

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 * @param {K} key
 * @param {Observable<TEntity[K]>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}   *
 */
export function set(key, value) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(
            value.subscribe({
              next: (v) => {
                entity[key] = v;
              },
              error: (err) => subscriber.error(err),
            }),
          );
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @template {object} TEntity
 * @template {keyof CopyableProps<TEntity>} K
 * @param {K} key
 * @param {Observable<TEntity[K]>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function copy(key, value) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(
            value.subscribe({
              next: (v) => {
                /** @type {Record<K, { copy: (v: TEntity[K]) => void }>} */ (
                  entity
                )[key].copy(v);
              },
            }),
          );
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 *
 * @param {Object3D<any>} parent
 * @param {Observable<Component>} child
 */
export function addToParent(parent, child) {
  return child.pipe(
    distinctUntilChanged(),
    switchMap((component) => {
      return new Observable(() => {
        return component.addTo(parent);
      });
    }),
  );
}

/**
 * @template {Object3D<any>} TEntity
 * @param {Observable<Component>[]} children
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function add(...children) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          children.forEach((child) => {
            subscriber.add(addToParent(entity, child).subscribe());
          });
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @template T
 * @param {(entity: T) => Observable<unknown>} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effect(fn) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(fn(entity).subscribe());
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @template T
 * @param {T} value
 * @returns {Observable<T>}
 */
export function just(value) {
  return new Observable((subscriber) => {
    subscriber.next(value);
  });
}

/**
 * @typedef {object} Disposable
 * @property {() => void} dispose
 */

/**
 * @template {Disposable} T
 * @template {unknown[]} Args
 * @param {(...args: Args) => T} factory
 * @returns {(source: Observable<Args>) => Observable<T>}
 */
export function disposable(factory) {
  return switchMap(
    /**
     * @param {Args} args
     * @returns {Observable<T>}
     */
    (args) => {
      return new Observable((subscriber) => {
        const value = factory(...args);
        subscriber.next(value);
        return () => {
          value.dispose();
        };
      });
    },
  );
}

/**
 * @returns {(source: Observable<Object3D | null>) => Observable<Component>}
 */
export function toComponent() {
  return (source) => {
    return new Observable((subscriber) => {
      subscriber.add(
        source.subscribe({
          next: (entity) => {
            if (!entity) {
              subscriber.next({
                addTo: () => () => {},
              });
            } else {
              subscriber.next({
                addTo: (parent) => {
                  parent.add(entity);
                  return () => {
                    parent.remove(entity);
                  };
                },
              });
            }
          },
        }),
      );
    });
  };
}

export function Nothing() {
  return just(null).pipe(toComponent());
}

/**
 * @template {Object3D} T
 * @param {T} object
 * @param {Array<(source: Observable<T>) => Observable<T>>} [operators]
 * @returns {Observable<Component>}
 */
export function $(object, operators = []) {
  const observable = operators.reduce(
    (obs, operator) => operator(obs),
    just(object),
  );
  return toComponent()(observable);
}
