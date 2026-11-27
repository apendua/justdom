import {
  $,
  attr,
  branch,
  children,
  CLASS_NAME,
  className,
  style,
  stylesheet,
  text,
} from "justdom-core";
import { Derived } from "justdom-signal";
import { xrSession } from "justdom-xr/session";
import { CATEGORY_LABELS, type Element } from "../data/elements";
import {
  densityText,
  discoveredText,
  electronegativityText,
  kelvinText,
  massText,
  meltsText,
  noteOf,
  phaseText,
  stateCaption,
} from "../facts";
import { lookOf } from "../looks";
import { shownElement, type TableState } from "../store/TableState";
import { DIM, EDGE, FAINT, FONT, INK, MONO, SURFACE, tint } from "./theme";

/*
 * The inspector fills the gap in the table above the transition metals, as
 * on a classroom poster: the element under the pointer, or the one last
 * pressed, with its figures and a Bohr model of its shells. On a phone,
 * where the table scrolls sideways, it is a card under the table instead.
 */
const panel = stylesheet`
  .${CLASS_NAME} {
    grid-column: 3 / 13;
    grid-row: 1 / 4;
    display: flex;
    gap: 14px;
    align-items: stretch;
    box-sizing: border-box;
    min-width: 0;
    margin: 0 6px 10px;
    padding: 12px 14px;
    border: 1px solid ${EDGE};
    border-radius: 14px;
    background: ${SURFACE};
    font-family: ${FONT};
    color: ${INK};
    transition: border-color 0.4s ease;
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      margin: 0;
      padding: 10px;
      gap: 10px;
    }
  }
`;

const big = stylesheet`
  .${CLASS_NAME} {
    flex: none;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    box-sizing: border-box;
    width: 112px;
    padding: 8px 10px;
    border: 2px solid currentcolor;
    border-radius: 12px;
    box-shadow: 0 0 24px currentcolor;
    transition: color 0.4s ease, background-color 0.4s ease;
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      width: 84px;
    }
  }
`;

const bigNumber = className`
  font-size: 15px;
  font-weight: 600;
  color: ${INK};
`;

const bigSymbol = className`
  font-size: 50px;
  font-weight: 800;
  line-height: 1;
`;

const bigMass = className`
  font-size: 12px;
  color: ${INK};
`;

const details = className`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const title = className`
  font-size: 24px;
  font-weight: 700;
  line-height: 1.1;
`;

const headline = className`
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
`;

const line = className`
  flex: none;
  overflow: hidden;
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: ${DIM};
`;

const chip = className`
  padding: 2px 8px;
  border: 1px solid currentcolor;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
`;

const facts = stylesheet`
  .${CLASS_NAME} {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
    gap: 3px 10px;
    margin-top: 2px;
    font-size: 12px;
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      grid-template-columns: auto minmax(0, 1fr);
      gap: 1px 10px;
    }
  }
`;

const key = className`
  color: ${DIM};
  white-space: nowrap;
`;

const value = className`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const mono = className`
  flex: none;
  overflow: hidden;
  font-family: ${MONO};
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
`;

const remark = className`
  margin-top: auto;
  font-size: 11.5px;
  font-style: italic;
  color: ${FAINT};
`;

/** How far apart the shells are drawn, and the innermost one's radius, in px. */
const SHELL_STEP = 11;
const FIRST_SHELL = 22;
const BOHR_SIZE = 2 * (FIRST_SHELL + 6 * SHELL_STEP) + 8;

const bohr = stylesheet`
  .${CLASS_NAME} {
    position: relative;
    flex: none;
    width: ${BOHR_SIZE}px;
    height: ${BOHR_SIZE}px;
    align-self: center;
  }

  /* On a narrow page the model gives the figures its room. */
  @container table (max-width: 1100px) {
    .${CLASS_NAME} {
      display: none;
    }
  }
`;

const nucleus = className`
  position: absolute;
  left: 50%;
  top: 50%;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #ffffff, currentcolor 70%);
  box-shadow: 0 0 16px currentcolor;
`;

const orbit = stylesheet`
  .${CLASS_NAME} {
    position: absolute;
    left: 50%;
    top: 50%;
    box-sizing: border-box;
    border: 1px solid ${tint("#9aa6c6", 0.3)};
    border-radius: 50%;
    animation: periodic-spin linear infinite;
  }

  .${CLASS_NAME}[data-still] {
    animation-play-state: paused;
  }

  @keyframes periodic-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .${CLASS_NAME} {
      animation: none;
    }
  }
`;

const electron = className`
  position: absolute;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: currentcolor;
  box-shadow: 0 0 6px currentcolor;
`;

/**
 * The element's shells as rings, its electrons spaced evenly round each,
 * and each ring turning, the outer ones slower and every other one the
 * other way. In a session the rings hold still, since the scene beside the
 * table draws the same atom turning in three dimensions, and a panel with
 * nothing animating costs nothing a frame.
 */
function Bohr(element: Element) {
  return $("div", [
    attr("class", bohr),
    children(
      $("div", [attr("class", nucleus)]),
      ...element.shells.map((count, shell) => {
        const radius = FIRST_SHELL + shell * SHELL_STEP;
        return $("div", [
          attr("class", orbit),
          attr("data-still", () => (xrSession.get() ? "" : undefined)),
          style({
            width: `${2 * radius}px`,
            height: `${2 * radius}px`,
            marginLeft: `${-radius}px`,
            marginTop: `${-radius}px`,
            animationDuration: `${5 + shell * 3}s`,
            animationDirection: shell % 2 ? "reverse" : "normal",
          }),
          children(
            ...Array.from({ length: count }, (_, i) => {
              const angle = (2 * Math.PI * i) / count - Math.PI / 2;
              return $("div", [
                attr("class", electron),
                style({
                  left: `${radius + radius * Math.cos(angle)}px`,
                  top: `${radius + radius * Math.sin(angle)}px`,
                }),
              ]);
            }),
          ),
        ]);
      }),
    ),
  ]);
}

function fact(caption: string | (() => string), content: () => string) {
  return [
    $("span", [attr("class", key), children(text`${caption}`)]),
    $("span", [attr("class", value), children(text`${content}`)]),
  ];
}

/** The group an element's column is, or the f-block's name for the rows under the table. */
function placeText(element: Element): string {
  const group = element.row > 7 ? "f-block" : `Group ${element.column}`;
  return `Period ${element.period} · ${group}`;
}

export function Inspector(state: TableState) {
  const shown = new Derived(() => shownElement(state));
  const look = new Derived(() => lookOf(shown.get(), state));
  const at = (pick: (element: Element) => string) => () => pick(shown.get());

  return $("div", [
    attr("class", panel),
    // What the table's grid docks under it on a phone.
    attr({ "data-inspector": "" }),
    style("borderColor", () => tint(look.get().tone, 0.5)),
    style("color", () => look.get().tone),
    children(
      $("div", [
        attr("class", big),
        style("backgroundColor", () => tint(look.get().tone, 0.16)),
        children(
          $("span", [attr("class", bigNumber), children(text`${at((e) => String(e.number))}`)]),
          $("span", [attr("class", bigSymbol), children(text`${at((e) => e.symbol)}`)]),
          $("span", [attr("class", bigMass), children(text`${at(massText)}`)]),
        ),
      ]),
      $("div", [
        attr("class", details),
        style({ color: INK }),
        children(
          $("div", [
            attr("class", headline),
            children(
              $("span", [attr("class", title), children(text`${at((e) => e.name)}`)]),
              $("span", [
                attr("class", chip),
                style("color", () => look.get().tone),
                children(
                  text`${at((e) => `${CATEGORY_LABELS[e.category]}${e.predicted ? " · predicted" : ""}`)}`,
                ),
              ]),
            ),
          ]),
          $("span", [
            attr("class", line),
            children(text`${at((e) => `${placeText(e)} · shells ${e.shells.join(" · ")}`)}`),
          ]),
          $("span", [attr("class", mono), children(text`${at((e) => e.configuration)}`)]),
          $("div", [
            attr("class", facts),
            children(
              ...fact("Melts", at(meltsText)),
              ...fact(
                "Boils",
                at((e) => kelvinText(e.boils)),
              ),
              ...fact("Density", at(densityText)),
              ...fact("Electroneg.", at(electronegativityText)),
              ...fact("Discovered", at(discoveredText)),
              ...fact(
                () => stateCaption(state),
                at((e) => phaseText(e, state)),
              ),
            ),
          ]),
          $("div", [attr("class", remark), children(text`${at((e) => noteOf(e) ?? "")}`)]),
        ),
      ]),
      branch(
        () => shown.get(),
        (element) => Bohr(element),
      ),
    ),
  ]);
}
