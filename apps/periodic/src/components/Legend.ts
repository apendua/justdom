import {
  $,
  attr,
  branch,
  children,
  CLASS_NAME,
  className,
  on,
  style,
  stylesheet,
  text,
} from "justdom-core";
import { type Category, CATEGORY_LABELS, ELEMENTS, type Phase, phaseAt } from "../data/elements";
import {
  CATEGORY_TONES,
  EN_MAX,
  EN_MIN,
  EN_STOPS,
  ERAS,
  PHASE_TONES,
  PREDICTION_TONE,
  UNKNOWN_TONE,
} from "../looks";
import type { TableState } from "../store/TableState";
import { DIM, EDGE, FONT, INK, pressable, SURFACE, tint } from "./theme";

const legend = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
    font-family: ${FONT};
    font-size: 12px;
    color: ${INK};
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      margin-top: 10px;
      font-size: 11px;
    }
  }
`;

const entry = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 4px 6px;
    border: 1px solid ${EDGE};
    border-radius: 999px;
    background: ${SURFACE};
    transition: background-color 0.2s ease, transform 0.15s ease;
  }

  .${CLASS_NAME}[data-pick] {
    ${pressable}
  }

  .${CLASS_NAME}[data-pick]:hover {
    transform: translateY(-1px);
    background: ${tint("#ffffff", 0.08)};
  }
`;

const dot = className`
  width: 12px;
  height: 12px;
  border: 1px solid currentcolor;
  border-radius: 4px;
`;

const scale = className`
  width: 220px;
  height: 12px;
  border-radius: 6px;
`;

const note = className`
  margin-left: 6px;
  color: ${DIM};
`;

function Swatch(tone: string, label: string) {
  return $("span", [
    attr("class", entry),
    children(
      $("span", [attr("class", dot), style({ color: tone, backgroundColor: tint(tone, 0.35) })]),
      $("span", [children(text`${label}`)]),
    ),
  ]);
}

/**
 * A category to pick out: while the pointer or a ray is on it, every tile
 * of another category dims, and a press picks it out or lets it go. A
 * finger's arrival and departure are no hover: a tap sends both around its
 * click, and if they set and cleared the pick, a second tap could never
 * let it go.
 */
export function Pick(category: Category, state: TableState) {
  const tone = CATEGORY_TONES[category];
  return $("span", [
    attr("class", entry),
    attr({ "data-pick": "" }),
    on("pointerenter", (event: PointerEvent) => {
      if (event.pointerType !== "touch") {
        state.highlight = category;
      }
    }),
    on("pointerleave", (event: PointerEvent) => {
      if (event.pointerType !== "touch" && state.highlight === category) {
        state.highlight = null;
      }
    }),
    on("click", () => {
      state.highlight = state.highlight === category ? null : category;
    }),
    children(
      $("span", [attr("class", dot), style({ color: tone, backgroundColor: tint(tone, 0.35) })]),
      $("span", [children(text`${CATEGORY_LABELS[category]}`)]),
    ),
  ]);
}

/** What the colours mean in the view that is on. */
export function Legend(state: TableState) {
  return $("div", [
    attr("class", legend),
    children(
      branch(
        () => state.mode,
        (mode) => {
          switch (mode) {
            case "category":
              return $("div", [
                attr("class", legend),
                style({ marginTop: "0" }),
                children(
                  ...(Object.keys(CATEGORY_LABELS) as Category[]).map((category) =>
                    Pick(category, state),
                  ),
                ),
              ]);
            case "phase":
              return $("div", [
                attr("class", legend),
                style({ marginTop: "0" }),
                children(
                  Swatch(PHASE_TONES.solid, "Solid"),
                  Swatch(PHASE_TONES.liquid, "Liquid"),
                  Swatch(PHASE_TONES.gas, "Gas"),
                  Swatch(UNKNOWN_TONE, "Not known"),
                  $("span", [
                    attr("class", note),
                    children(
                      text`${() => {
                        const count = (phase: Phase) =>
                          ELEMENTS.filter((e) => phaseAt(e, state.kelvin) === phase).length;
                        return `${count("liquid")} liquid, ${count("gas")} gas at one atmosphere`;
                      }}`,
                    ),
                  ]),
                ),
              ]);
            case "electronegativity":
              return $("div", [
                attr("class", legend),
                style({ marginTop: "0" }),
                children(
                  $("span", [children(text`${EN_MIN.toFixed(2)}`)]),
                  $("span", [
                    attr("class", scale),
                    style({ backgroundImage: `linear-gradient(90deg, ${EN_STOPS.join(", ")})` }),
                  ]),
                  $("span", [children(text`${EN_MAX.toFixed(2)}`)]),
                  Swatch(UNKNOWN_TONE, "Not measured"),
                ),
              ]);
            case "discovery":
              return $("div", [
                attr("class", legend),
                style({ marginTop: "0" }),
                children(
                  ...ERAS.map((era) => Swatch(era.tone, era.label)),
                  Swatch(PREDICTION_TONE, "An element Mendeleev left room for"),
                  $("span", [
                    attr("class", note),
                    children(
                      text`${() => `${ELEMENTS.filter((e) => e.discovered <= state.year).length} of 118 known in ${state.year}`}`,
                    ),
                  ]),
                ),
              ]);
          }
        },
      ),
    ),
  ]);
}
