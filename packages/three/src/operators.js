import {
  distinctUntilChanged,
  Observable,
  ReplaySubject,
  share,
  switchMap,
} from "rxjs";

/**
 * @import { WritableProps, CopyableProps, XREventMap, Parent, EventListener } from './core.js';
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
 * @template TChild
 * @template {Parent<TChild>} TEntity
 * @param {Observable<TChild | null>[]} children
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function add(...children) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          children.forEach((child) => {
            subscriber.add(
              child
                .pipe(
                  distinctUntilChanged(),
                  switchMap((childEntity) => {
                    return new Observable(() => {
                      if (childEntity) {
                        entity.add(childEntity);
                      }
                      return () => {
                        if (childEntity) {
                          entity.remove(childEntity);
                        }
                      };
                    });
                  }),
                )
                .subscribe(),
            );
            subscriber.next(entity);
          });
        });
      }),
    );
  };
}

/**
 * @template T
 * @param {(entity: T) => Observable<never>} fn
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
 * @template T
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function sharedResource() {
  return share({
    connector: () => new ReplaySubject(1),
  });
}
