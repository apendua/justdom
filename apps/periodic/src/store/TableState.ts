import { store } from "justdom-signal";
import type { Category, Element } from "../data/elements";
import { elementByNumber, ROOM_KELVIN } from "../data/elements";
import type { Mode, View } from "../looks";
import { YEAR_MAX } from "../looks";

/** The element the inspector shows before anyone points at one: gold. */
export const FIRST_PINNED = 79;

/**
 * Everything the table's views read: which view is on and its setting, the
 * element under the pointer, the one last pressed, and the category the
 * legend is pointing out. One store, made by `main.ts` and handed both to
 * the page and to the headset's scene, which draws the same element's atom.
 */
export interface TableState extends View {
  /** The element under the pointer, or a ray. */
  hovered: number | null;
  /** The element last pressed, which the inspector shows when none is hovered. */
  pinned: number;
  /** The category the pointer is on in the legend, whose tiles stand out. */
  highlight: Category | null;
  /** Whether the discovery view is playing its years through. */
  playing: boolean;
}

export function createTableState(): TableState {
  return store<TableState>({
    mode: "category" as Mode,
    // The state view starts at room temperature.
    kelvin: ROOM_KELVIN,
    year: YEAR_MAX,
    hovered: null,
    pinned: FIRST_PINNED,
    highlight: null,
    playing: false,
  });
}

/** The element the inspector and the atom show: the hovered one, else the pinned one. */
export function shownElement(state: TableState): Element {
  const number = state.hovered ?? state.pinned;
  const element = elementByNumber(number);
  if (!element) {
    throw new Error(`No element ${number}`);
  }
  return element;
}
