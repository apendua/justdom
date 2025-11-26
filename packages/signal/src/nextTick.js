import { Observable } from "rxjs";

/**
 * @returns {Observable<void>}
 */
function nextTick() {
  return new Observable((subscriber) => {
    /** @type {number | undefined} */
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

export default nextTick;
