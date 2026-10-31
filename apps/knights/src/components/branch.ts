import { list, type Mountable } from "justdom";
import type { Source, Subscribable } from "justdom-signal";

/**
 * Renders one of several alternatives, chosen by a key.
 *
 * It's a list that never holds more than one item, which gives us exactly the
 * behavior we want from a conditional: the alternative currently on screen is
 * unmounted as soon as the key changes, and stays mounted — keeping whatever
 * state it holds — for as long as it doesn't.
 */
export default function branch<T extends string>(
  select: () => T,
  render: (key: T) => Subscribable<Mountable>,
): Source<Mountable> {
  return list(() => [select()], render);
}
