import { createMirror } from "../elements/mirror.js";
import { OBSERVER_OPTIONS } from "../elements/portal.js";

/**
 * A mirror fed by an observer watching `root` as a portal watches its
 * container, so a write reaches what the mirror drives only if a portal
 * would have reported it. `flush` hands the observer's records to the
 * mirror there and then, where a portal would wait for the observer's
 * microtask.
 *
 * @param {Element} root
 */
export function observedMirror(root) {
  const mirror = createMirror();
  const observer = new window.MutationObserver(() => {});
  observer.observe(root, OBSERVER_OPTIONS);
  return {
    mirror,
    flush() {
      mirror.ingest(observer.takeRecords());
    },
    disconnect() {
      observer.disconnect();
    },
  };
}
