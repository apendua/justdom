import {
  $,
  attr,
  children,
  CLASS_NAME,
  className,
  on,
  style,
  stylesheet,
  text,
} from "justdom-core";
import { Derived } from "justdom-signal";
import type { Element } from "../data/elements";
import { lookOf } from "../looks";
import type { TableState } from "../store/TableState";
import { DIM, FONT, INK, pressable, tint } from "./theme";

/*
 * A tile is a button tinted with its tone: the border, the symbol and the
 * glow under the pointer are the tone itself (`currentcolor`), the
 * background a wash of it. The tone is the one inline style a view change
 * writes, so a change of view is a colour transition and nothing else.
 *
 * The hover and press rules are written for `:hover` and `:active` alone:
 * in a headset session justdom-three rewrites them to answer its ray as
 * well. The ray's own rule, after them, lifts the tile towards the viewer
 * with `translateZ`, which on a page would do nothing.
 */
const tile = stylesheet`
  .${CLASS_NAME} {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    box-sizing: border-box;
    min-width: 0;
    margin: 0;
    padding: 4px 5px 3px;
    border: 1px solid currentcolor;
    border-radius: 7px;
    font-family: ${FONT};
    text-align: left;
    ${pressable}
    transition:
      transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
      background-color 0.45s ease,
      border-color 0.45s ease,
      color 0.45s ease,
      opacity 0.45s ease,
      box-shadow 0.2s ease;
    animation: periodic-tile-in 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
  }

  .${CLASS_NAME}:hover {
    transform: scale(1.16);
    box-shadow: 0 0 18px 2px currentcolor;
    z-index: 3;
  }

  .${CLASS_NAME}[data-xr-hover] {
    transform: translateZ(16px) scale(1.16);
  }

  .${CLASS_NAME}:active {
    transform: scale(1.06);
  }

  .${CLASS_NAME}[data-pinned] {
    outline: 2px solid ${INK};
    outline-offset: 1px;
  }

  .${CLASS_NAME}[data-dim] {
    opacity: 0.22;
  }

  .${CLASS_NAME}[data-ghost] {
    opacity: 0.12;
  }

  .${CLASS_NAME}[data-prophecy] {
    opacity: 1;
  }

  .${CLASS_NAME}[data-fresh] {
    box-shadow: 0 0 14px 1px currentcolor;
  }

  @keyframes periodic-tile-in {
    from {
      opacity: 0;
      transform: translateY(18px) scale(0.6);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .${CLASS_NAME} {
      animation: none;
    }
  }
`;

const number = className`
  font-size: 10px;
  line-height: 1;
  color: ${DIM};
`;

const symbol = className`
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
`;

const caption = stylesheet`
  .${CLASS_NAME} {
    overflow: hidden;
    font-size: 8.5px;
    line-height: 1.1;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: ${INK};
  }

  /* On a narrow page the tile keeps its number and symbol only. */
  @container table (max-width: 900px) {
    .${CLASS_NAME} {
      display: none;
    }
  }
`;

/**
 * One element's tile, placed in the table's grid by its column and row. It
 * reports the pointer to the state as it comes and goes, and a press pins
 * the element in the inspector. A finger's arrival is no hover: on a phone
 * a tap pins, and the popup is for a mouse or a ray.
 */
export function Tile(element: Element, state: TableState) {
  const look = new Derived(() => lookOf(element, state));
  const order = element.column + element.row * 2;
  return $("button", [
    attr("class", tile),
    attr({ type: "button", "aria-label": element.name }),
    style({
      gridColumn: String(element.column),
      gridRow: String(element.row),
      animationDelay: `${order * 22}ms`,
    }),
    style("color", () => look.get().tone),
    style("backgroundColor", () => tint(look.get().tone, look.get().prophecy ? 0.05 : 0.16)),
    attr("data-pinned", () => (state.pinned === element.number ? "" : undefined)),
    attr("data-dim", () =>
      state.highlight && state.highlight !== element.category ? "" : undefined,
    ),
    attr("data-ghost", () => (look.get().known ? undefined : "")),
    attr("data-prophecy", () => (look.get().prophecy ? "" : undefined)),
    attr("data-fresh", () => (look.get().fresh ? "" : undefined)),
    on("pointerenter", (event: PointerEvent) => {
      if (event.pointerType !== "touch") {
        state.hovered = element.number;
      }
    }),
    on("pointerleave", () => {
      if (state.hovered === element.number) {
        state.hovered = null;
      }
    }),
    on("click", () => {
      state.pinned = element.number;
    }),
    children(
      $("span", [attr("class", number), children(text`${element.number}`)]),
      $("span", [
        attr("class", symbol),
        children(text`${() => (look.get().prophecy ? "?" : element.symbol)}`),
      ]),
      $("span", [
        attr("class", caption),
        children(text`${() => look.get().prophecy ?? look.get().badge ?? element.name}`),
      ]),
    ),
  ]);
}

/**
 * Where the lanthanides or the actinides would stand in the table, pointing
 * down at the row they are set out in.
 */
export function SeriesMarker(
  label: string,
  tone: string,
  column: number,
  row: number,
  isDim: () => boolean,
) {
  return $("div", [
    attr("class", tile),
    style({
      gridColumn: String(column),
      gridRow: String(row),
      color: tone,
      backgroundColor: tint(tone, 0.08),
      cursor: "default",
      justifyContent: "center",
      alignItems: "center",
      animationDelay: `${(column + row * 2) * 22}ms`,
    }),
    attr("data-dim", () => (isDim() ? "" : undefined)),
    children($("span", [attr("class", number), children(text`${label}`)])),
  ]);
}
