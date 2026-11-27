import { xrSession } from "justdom-xr/session";
import type { TableState } from "./TableState";

/** How long a ray rests on a tile before the inspector and the atom follow it, in ms. */
export const SETTLE_MS = 150;

export interface Pointer {
  /** The pointer, a mouse's or a ray, has come onto element `number`'s tile. */
  enter(number: number): void;
  /** And has left it. */
  leave(number: number): void;
  /** Pins element `number`, and shows at once whatever is under the pointer. */
  pin(number: number): void;
}

/**
 * Reports the pointer to the state, as `hovered` at once and as `inspected`
 * once it has settled.
 *
 * On the page the two are the same, and the inspector follows the mouse
 * tile by tile. In a session every element the inspector shows is new text
 * and a new Bohr model for the panel to measure and upload, so a ray swept
 * across ten tiles would rebuild it ten times on the way. There `inspected`
 * follows `hovered` only once it has stayed `SETTLE_MS` on one tile, or on
 * none, and a sweep shows only where it ends.
 *
 * The rules: one timer at most. Each change of `hovered` in a session
 * starts it again; it ends by copying `hovered` into `inspected`. A change
 * on the page, and a pin anywhere, copies at once and takes the timer
 * down, so a trigger pulled before the ray settles shows what it pinned.
 *
 * `settles` says whether to wait, which is whether a session is on.
 */
export function createPointer(
  state: TableState,
  settles: () => boolean = () => xrSession.get() !== null,
): Pointer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const settle = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    state.inspected = state.hovered;
  };

  const point = (number: number | null) => {
    state.hovered = number;
    if (!settles()) {
      settle();
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(settle, SETTLE_MS);
  };

  return {
    enter: (number) => point(number),
    leave: (number) => {
      if (state.hovered === number) {
        point(null);
      }
    },
    pin: (number) => {
      state.pinned = number;
      settle();
    },
  };
}
