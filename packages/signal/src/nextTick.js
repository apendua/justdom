import { Observable, share } from "rxjs";

/**
 * @returns {Observable<void>}
 */
function nextTick() {
  return new Observable((subscriber) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let handle;
    function scheduleNextTick() {
      return setTimeout(() => {
        subscriber.next();
        if (!subscriber.closed) {
          handle = scheduleNextTick();
        }
      });
    }
    handle = scheduleNextTick();
    return () => {
      clearTimeout(handle);
    };
  });
}

export const onNextTick = nextTick().pipe(
  share({
    resetOnRefCountZero: true,
  }),
);

export default nextTick;
