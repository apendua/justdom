import { list, type Mountable } from "@apendua.dev/dom";
import type { Observable } from "rxjs";

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
  render: (key: T) => Observable<Mountable<Node>>,
): Observable<Mountable<Node>> {
  return list(() => [select()], render);
}
