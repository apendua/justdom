import { xrSession } from "justdom-xr/session";
import { Derived, Signal } from "justdom-signal";
import type { makeReveal } from "justdom-three";

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

/** `makeReveal` from justdom-three, which draws as much of a text as is typed. */
export type MakeReveal = typeof makeReveal;

/**
 * justdom-three's `makeReveal`, once the scene has been loaded, and null
 * until then. `makeReveal` imports the mirror and three.js's core with it,
 * and the monitor only needs it while a session mirrors the desk
 * (`screen.ts`), so `xr.ts` puts it here as it loads instead of the page
 * importing it.
 */
export const revealer = Signal.of<MakeReveal | null>(null);

/**
 * What the monitor reveals its listing with while a session mirrors the
 * desk, and null on the page. No session can start before `xr.ts` has
 * loaded, so one that presents always finds `revealer` set.
 */
export const revealing = new Derived(() => (presenting.get() ? revealer.get() : null));
