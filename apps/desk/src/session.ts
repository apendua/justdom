import { xrSession } from "@apendua.dev/headset/session";
import { Derived } from "@apendua/signal";

/**
 * Whether a session is showing the desk, for the two things the page does
 * differently while it is mirrored: the staging (`stage.ts`) and how the
 * monitor types (`screen.ts`).
 */
export const presenting = new Derived(() => xrSession.get() !== null);

/** Something that can be read for a value, as a signal or a derivation can. */
export interface Readable<T> {
  get(): T;
}
