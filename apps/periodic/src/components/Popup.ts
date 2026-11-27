import { $, attr, children, CLASS_NAME, className, style, stylesheet, text } from "justdom-core";
import { Derived } from "justdom-signal";
import { CATEGORY_LABELS, type Element } from "../data/elements";
import { discoveredText, massText, meltsText, noteOf, phaseText, stateCaption } from "../facts";
import { lookOf } from "../looks";
import type { TableState } from "../store/TableState";
import { DIM, EDGE, FONT, INK, SURFACE_RAISED, tint } from "./theme";

/*
 * The popup is placed over its tile from the tile's column and row, with the
 * same track sizes as the grid (`--row`, `--gap` and the spacer row a
 * quarter of a row high), so it needs no measuring. The outer box only
 * places it; the card inside it plays the entrance, since the place is a
 * transform of its own.
 */
const anchor = className`
  position: absolute;
  z-index: 10;
  width: 0;
  height: 0;
  pointer-events: none;
`;

const card = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    width: 224px;
    padding: 10px 12px;
    border: 1px solid currentcolor;
    border-radius: 12px;
    background: ${SURFACE_RAISED};
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
    font-family: ${FONT};
    color: ${INK};
    pointer-events: none;
    animation: periodic-pop 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.3) both;
  }

  @keyframes periodic-pop {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.85);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .${CLASS_NAME} {
      animation: none;
    }
  }

  /* On a phone a tap pins the element in the inspector, and there is no popup. */
  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      display: none;
    }
  }
`;

const head = className`
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
`;

const badge = className`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid currentcolor;
  border-radius: 8px;
  font-size: 20px;
  font-weight: 700;
`;

const name = className`
  font-size: 15px;
  font-weight: 700;
  color: ${INK};
`;

const sub = className`
  font-size: 11px;
  color: ${DIM};
`;

const row = className`
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 0;
  border-top: 1px solid ${EDGE};
  font-size: 11.5px;
`;

const label = className`
  color: ${DIM};
`;

const note = className`
  margin-top: 6px;
  font-size: 11px;
  font-style: italic;
  color: currentcolor;
`;

/** Where the top of row `row` is, in the grid's own track sizes. */
function rowTop(row: number): string {
  const tracks = row <= 7 ? row - 1 : 7;
  const spacer = row > 7 ? " + var(--row) / 4 + var(--gap)" : "";
  const below = row > 8 ? row - 9 : 0;
  return `calc(${tracks + below} * (var(--row) + var(--gap))${spacer})`;
}

/** Where the middle of column `column` is, of 18 columns with gaps between. */
function columnMiddle(column: number): string {
  return `calc((100% + var(--gap)) * ${(column - 0.5) / 18} - var(--gap) / 2)`;
}

/**
 * Lined up over the tile, and pushed inwards by the two columns at each
 * edge, so that it stays over the table.
 */
function shift(column: number): string {
  if (column <= 2) return "-18%";
  if (column >= 17) return "-82%";
  return "-50%";
}

/**
 * Above the tile, except on the top four rows, where above is the title or
 * the inspector, which shows the same element: there it hangs below.
 */
function lift(row: number): string {
  return row <= 4 ? "calc(var(--row) + 10px)" : "calc(-100% - 10px)";
}

function fact(caption: string | (() => string), value: () => string) {
  return $("div", [
    attr("class", row),
    children(
      $("span", [attr("class", label), children(text`${caption}`)]),
      $("span", [children(text`${value}`)]),
    ),
  ]);
}

/** The card over element `element`'s tile while the pointer or a ray is on it. */
export function Popup(element: Element, state: TableState) {
  const look = new Derived(() => lookOf(element, state));
  const remark = noteOf(element);
  return $("div", [
    attr("class", anchor),
    style({
      left: columnMiddle(element.column),
      top: rowTop(element.row),
    }),
    children(
      $("div", [
        style({ transform: `translate(${shift(element.column)}, ${lift(element.row)})` }),
        children(
          $("div", [
            attr("class", card),
            style("color", () => look.get().tone),
            children(
              $("div", [
                attr("class", head),
                children(
                  $("div", [
                    attr("class", badge),
                    style("backgroundColor", () => tint(look.get().tone, 0.18)),
                    children(text`${element.symbol}`),
                  ]),
                  $("div", [
                    children(
                      $("div", [attr("class", name), children(text`${element.name}`)]),
                      $("div", [
                        attr("class", sub),
                        children(
                          text`${element.number} · ${CATEGORY_LABELS[element.category]}${element.predicted ? " (predicted)" : ""}`,
                        ),
                      ]),
                    ),
                  ]),
                ),
              ]),
              fact("Atomic mass", () => `${massText(element)} u`),
              fact(
                () => stateCaption(state),
                () => phaseText(element, state),
              ),
              fact("Melts", () => meltsText(element)),
              fact("Discovered", () => discoveredText(element)),
              ...(remark ? [$("div", [attr("class", note), children(text`${remark}`)])] : []),
            ),
          ]),
        ),
      ]),
    ),
  ]);
}
