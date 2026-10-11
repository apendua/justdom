/**
 * How the portal hears a property a script assigns. Writing `input.value`
 * or `input.checked` moves no attribute, so no MutationObserver reports it,
 * and the only way to hear it is an own accessor on the element that calls
 * through to the browser's and then says so. This module is that accessor,
 * and the count that keeps one per element however many panels follow it:
 * a field's `value` (`trackValue` in `textInput.js`) and a checkbox's
 * `checked` (`getCheckedCached` in `mirror.js`).
 */

/**
 * What the first holder of each element and key installed, and how many
 * hold it now.
 *
 * @type {WeakMap<object, Map<string, { count: number, dispose: () => void }>>}
 */
const holds = new WeakMap();

/**
 * Hold what `install` puts on `element` under `key`: the first holder
 * installs it, every holder after shares it, and the last one to let go
 * takes it down. Two holders of one element are ordinary, the same
 * `<input>` mirrored by a panel re-mounting while the one it replaces is
 * still coming down, and a second holder that installed its own over the
 * first's, or a first that took it away from under the second, would leave
 * the other deaf to an assignment.
 *
 * @param {object} element
 * @param {string} key
 * @param {() => () => void} install Puts the hooks up and returns how to
 *   take them down.
 * @returns {() => void} Let go. Calling it again does nothing.
 */
export function holdShared(element, key, install) {
  let keys = holds.get(element);
  if (!keys) {
    keys = new Map();
    holds.set(element, keys);
  }
  const existing = keys.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    keys.set(key, { count: 1, dispose: install() });
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const hold = keys.get(key);
    if (!hold) {
      return;
    }
    hold.count -= 1;
    if (hold.count === 0) {
      keys.delete(key);
      hold.dispose();
    }
  };
}

/**
 * Shadow the browser's accessor for `name` with an own one on `element`
 * that reads through it and hands every write to `set`, which writes
 * through `write` and announces what it likes.
 *
 * The accessor is looked up along the prototype chain rather than on a
 * global such as `HTMLInputElement`, which the element's document may not
 * share with this code; the first prototype carrying an own descriptor for
 * `name` is the one the browser defined it on. An element that already
 * carries an own `name`, an app's or a library's, is left with it, and so
 * is one defined over ours later: the restore takes off only the accessor
 * this installed.
 *
 * @template T
 * @param {object} element
 * @param {string} name
 * @param {(value: T, write: (value: T) => void, read: () => T) => void} set
 * @returns {(() => void) | null} Take the accessor off again, or null when
 *   none was installed.
 */
export function shadowAccessor(element, name, set) {
  if (Object.hasOwn(element, name)) {
    return null;
  }
  /** @type {PropertyDescriptor | undefined} */
  let descriptor;
  for (let proto = Object.getPrototypeOf(element); proto && !descriptor;) {
    descriptor = Object.getOwnPropertyDescriptor(proto, name);
    proto = Object.getPrototypeOf(proto);
  }
  const getter = descriptor?.get;
  const setter = descriptor?.set;
  if (!getter || !setter) {
    return null;
  }
  const read = () => getter.call(element);
  /** @param {T} value */
  const write = (value) => {
    setter.call(element, value);
  };
  /** @param {T} value */
  const own = (value) => {
    set(value, write, read);
  };
  Object.defineProperty(element, name, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      return getter.call(this);
    },
    set: own,
  });
  return () => {
    // The own property gone, the prototype's accessor is the one found
    // again. One somebody defined over ours since is theirs to keep.
    if (Object.getOwnPropertyDescriptor(element, name)?.set === own) {
      Reflect.deleteProperty(element, name);
    }
  };
}
