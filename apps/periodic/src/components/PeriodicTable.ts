import { $, attr, branch, children, CLASS_NAME, Nothing, stylesheet } from "justdom-core";
import { xrSession } from "justdom-xr/session";
import { ELEMENTS, elementByNumber } from "../data/elements";
import { CATEGORY_TONES } from "../looks";
import { createPointer } from "../store/pointer";
import type { TableState } from "../store/TableState";
import { Controls } from "./Controls";
import { Inspector } from "./Inspector";
import { Legend } from "./Legend";
import { Popup } from "./Popup";
import { SeriesMarker, Tile } from "./Tile";
import { EDGE, FONT, NIGHT } from "./theme";

/*
 * The whole table is one card, which a headset session mirrors into one
 * panel. It paints a surface of its own, so the panel has one too.
 *
 * The grid is 18 columns by 10 rows: the seven periods, a spacer a quarter
 * of a row high, and the f-block's two rows. `--row` and `--gap` size it,
 * and the popup reads the same two to find its tile without measuring.
 * On a phone the columns keep a width a finger can hit, and the grid
 * scrolls sideways under the inspector, which docks at the bottom.
 *
 * In a session nothing on the card fades: a transition is a restyle of
 * every box it runs on, read again by the panel on every frame it runs,
 * and a change of view would fade all 118 tiles for half a second. There
 * the change lands in one step, as do the tile's lift and glow under the
 * ray.
 */
const card = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    width: 100%;
    max-width: 1280px;
    margin: 0 auto;
    padding: 18px 22px 20px;
    border: 1px solid ${EDGE};
    border-radius: 22px;
    background-color: ${NIGHT};
    background-image: radial-gradient(circle at 30% 0%, #1b2547 0%, ${NIGHT} 65%);
    font-family: ${FONT};
  }

  .${CLASS_NAME}[data-session],
  .${CLASS_NAME}[data-session] * {
    transition: none !important;
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      padding: 12px 10px 230px;
      border: none;
      border-radius: 0;
    }
  }
`;

const scroller = stylesheet`
  .${CLASS_NAME} {
    padding-top: 6px;
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      overflow-x: auto;
      margin: 0 -10px;
      padding: 6px 10px 4px;
    }
  }
`;

const grid = stylesheet`
  .${CLASS_NAME} {
    --row: 62px;
    --gap: 4px;
    position: relative;
    display: grid;
    grid-template-columns: repeat(18, minmax(0, 1fr));
    grid-template-rows: repeat(7, var(--row)) calc(var(--row) / 4) repeat(2, var(--row));
    gap: var(--gap);
  }

  @container table (max-width: 1000px) {
    .${CLASS_NAME} {
      --row: 50px;
      --gap: 3px;
    }
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      --row: 46px;
      width: max-content;
      grid-template-columns: repeat(18, 38px);
    }

    /* The inspector, out of the grid and docked under the table. */
    .${CLASS_NAME} > [data-inspector] {
      position: fixed;
      z-index: 20;
      left: 0;
      right: 0;
      bottom: 0;
      height: 216px;
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.5);
    }
  }
`;

const LANTHANIDES = { label: "57–71", tone: CATEGORY_TONES.lanthanide };
const ACTINIDES = { label: "89–103", tone: CATEGORY_TONES.actinide };

export function PeriodicTable(state: TableState) {
  const pointer = createPointer(state);
  return $("div", [
    attr("class", card),
    attr("data-session", () => (xrSession.get() ? "" : undefined)),
    children(
      Controls(state),
      $("div", [
        attr("class", scroller),
        children(
          $("div", [
            attr("class", grid),
            children(
              Inspector(state),
              ...ELEMENTS.map((element) => Tile(element, state, pointer)),
              SeriesMarker(LANTHANIDES.label, LANTHANIDES.tone, 3, 6, () =>
                Boolean(state.highlight && state.highlight !== "lanthanide"),
              ),
              SeriesMarker(ACTINIDES.label, ACTINIDES.tone, 3, 7, () =>
                Boolean(state.highlight && state.highlight !== "actinide"),
              ),
              // Not in a session, where it would be a new card for the
              // panel to build on every tile the ray crosses, and the
              // inspector and the atom already show the element.
              branch(
                () => (xrSession.get() ? null : state.hovered),
                (number) => {
                  const element = number === null ? undefined : elementByNumber(number);
                  return element ? Popup(element, state) : Nothing();
                },
              ),
            ),
          ]),
        ),
      ]),
      Legend(state),
    ),
  ]);
}
