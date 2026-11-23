import {
  type Category,
  type Element,
  type Phase,
  MENDELEEV_NAMED,
  MENDELEEV_PREDICTIONS,
  MENDELEEV_YEAR,
  phaseAt,
} from "./data/elements";

/**
 * How the table colours its tiles, as plain functions of an element and the
 * view's settings, so the page, the legend and the tests read one rule.
 */

export type Mode = "category" | "phase" | "electronegativity" | "discovery";

export const MODES: readonly { id: Mode; label: string }[] = [
  { id: "category", label: "Category" },
  { id: "phase", label: "State" },
  { id: "electronegativity", label: "Electronegativity" },
  { id: "discovery", label: "Discovery" },
];

export const CATEGORY_TONES: Readonly<Record<Category, string>> = {
  "alkali-metal": "#ff6f61",
  "alkaline-earth": "#ffa552",
  "transition-metal": "#ffd166",
  "post-transition": "#a8e06c",
  metalloid: "#4fd1a5",
  nonmetal: "#5cc8ff",
  halogen: "#7f9cff",
  "noble-gas": "#b78cff",
  lanthanide: "#ff86d0",
  actinide: "#d6a77a",
};

export const PHASE_TONES: Readonly<Record<Phase, string>> = {
  solid: "#7aa2ff",
  liquid: "#36d6c3",
  gas: "#ff9f6b",
};

/** A tile nothing is known about in this view. */
export const UNKNOWN_TONE = "#5c6680";

/** The pink a gap Mendeleev left is drawn in. */
export const PREDICTION_TONE = "#ff5fa2";

/** The electronegativity scale's ends: caesium's 0.79 and fluorine's 3.98. */
export const EN_MIN = 0.79;
export const EN_MAX = 3.98;

/** The scale from the least electronegative element to the most. */
export const EN_STOPS: readonly string[] = ["#3d6bff", "#29c7c1", "#f7d046", "#ff4d4d"];

/** The eras the discovery view colours by, each to the year it ends. */
export const ERAS: readonly { until: number; label: string; tone: string }[] = [
  { until: 1599, label: "Antiquity to 1599", tone: "#ffd166" },
  { until: 1799, label: "1600–1799", tone: "#ffa552" },
  { until: MENDELEEV_YEAR, label: `1800–${MENDELEEV_YEAR}`, tone: "#5cc8ff" },
  { until: 1939, label: `${MENDELEEV_YEAR + 1}–1939`, tone: "#4fd1a5" },
  { until: Infinity, label: "1940 onwards", tone: "#b78cff" },
];

/** The temperature range the state view's slider covers, in kelvin. */
export const KELVIN_MAX = 6000;

/** And the discovery view's years. */
export const YEAR_MIN = 1600;
export const YEAR_MAX = 2026;

/** Years after an element's discovery during which its tile is shown as new. */
export const FRESH_YEARS = 12;

function mix(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  const out = [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The colour of electronegativity `value` on `EN_STOPS`. */
export function electronegativityTone(value: number): string {
  const t = Math.min(1, Math.max(0, (value - EN_MIN) / (EN_MAX - EN_MIN)));
  const span = t * (EN_STOPS.length - 1);
  const i = Math.min(EN_STOPS.length - 2, Math.floor(span));
  return mix(EN_STOPS[i], EN_STOPS[i + 1], span - i);
}

export function eraOf(year: number) {
  return ERAS.find((era) => year <= era.until) ?? ERAS[ERAS.length - 1];
}

export interface View {
  mode: Mode;
  kelvin: number;
  year: number;
}

/**
 * How one tile looks in `view`:
 *
 * - `tone`, the colour its border, glow and symbol are drawn in;
 * - `known`, false for an element the discovery view's year has not
 *   reached, which is drawn as a dim ghost;
 * - `prophecy`, for an element not yet found in a year Mendeleev's table
 *   already left room for it: the name he gave it, or `"gap"` before he
 *   named it;
 * - `fresh`, for an element discovered in the last `FRESH_YEARS` of the
 *   discovery view's year, which glows;
 * - `badge`, a short word the tile shows under its symbol in this view.
 */
export interface Look {
  tone: string;
  known: boolean;
  prophecy: string | null;
  fresh: boolean;
  badge: string | null;
}

export function lookOf(element: Element, view: View): Look {
  const base: Look = {
    tone: CATEGORY_TONES[element.category],
    known: true,
    prophecy: null,
    fresh: false,
    badge: null,
  };
  switch (view.mode) {
    case "category":
      return base;
    case "phase": {
      const phase = phaseAt(element, view.kelvin);
      return { ...base, tone: phase ? PHASE_TONES[phase] : UNKNOWN_TONE, badge: phase };
    }
    case "electronegativity": {
      const value = element.electronegativity;
      return {
        ...base,
        tone: value === null ? UNKNOWN_TONE : electronegativityTone(value),
        badge: value === null ? "–" : value.toFixed(2),
      };
    }
    case "discovery": {
      const known = element.discovered <= view.year;
      const prediction = MENDELEEV_PREDICTIONS[element.number];
      const prophecy =
        !known && prediction && view.year >= prediction.gapSince
          ? view.year >= MENDELEEV_NAMED
            ? prediction.name
            : "gap"
          : null;
      return {
        ...base,
        tone: prophecy ? PREDICTION_TONE : eraOf(element.discovered).tone,
        known,
        prophecy,
        fresh: known && element.discovered > 0 && view.year - element.discovered < FRESH_YEARS,
        badge: element.discovered === 0 ? "ancient" : String(element.discovered),
      };
    }
  }
}

/** Kelvin from the state view's slider at `position`, 0 to 1: finer at the cold end. */
export function kelvinAt(position: number): number {
  return Math.round(KELVIN_MAX * position * position);
}

export function positionOfKelvin(kelvin: number): number {
  return Math.sqrt(kelvin / KELVIN_MAX);
}

export function yearAt(position: number): number {
  return Math.round(YEAR_MIN + (YEAR_MAX - YEAR_MIN) * position);
}

export function positionOfYear(year: number): number {
  return (year - YEAR_MIN) / (YEAR_MAX - YEAR_MIN);
}

/** `kelvin` as the page writes it: `298 K · 25 °C`. */
export function formatKelvin(kelvin: number): string {
  return `${Math.round(kelvin)} K · ${Math.round(kelvin - 273.15)} °C`;
}
