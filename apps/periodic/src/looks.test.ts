import { describe, expect, it } from "vitest";
import { ELEMENTS, MENDELEEV_NAMED, MENDELEEV_YEAR } from "./data/elements";
import {
  CATEGORY_TONES,
  EN_STOPS,
  electronegativityTone,
  FRESH_YEARS,
  kelvinAt,
  lookOf,
  PHASE_TONES,
  positionOfKelvin,
  positionOfYear,
  PREDICTION_TONE,
  UNKNOWN_TONE,
  yearAt,
} from "./looks";

const element = (symbol: string) => {
  const found = ELEMENTS.find((e) => e.symbol === symbol);
  if (!found) throw new Error(symbol);
  return found;
};

const view = { mode: "category", kelvin: 298, year: 2026 } as const;

describe("lookOf", () => {
  it("colours by category", () => {
    expect(lookOf(element("Na"), view).tone).toBe(CATEGORY_TONES["alkali-metal"]);
  });

  it("colours by state at the view's temperature", () => {
    const phase = { ...view, mode: "phase" } as const;
    expect(lookOf(element("Hg"), phase)).toMatchObject({
      tone: PHASE_TONES.liquid,
      badge: "liquid",
    });
    expect(lookOf(element("Rf"), phase).tone).toBe(UNKNOWN_TONE);
  });

  it("colours by electronegativity, from one end of the scale to the other", () => {
    const en = { ...view, mode: "electronegativity" } as const;
    expect(lookOf(element("F"), en)).toMatchObject({ tone: EN_STOPS[3], badge: "3.98" });
    expect(lookOf(element("Cs"), en).tone).toBe(EN_STOPS[0]);
    expect(lookOf(element("He"), en)).toMatchObject({ tone: UNKNOWN_TONE, badge: "–" });
  });

  it("shows Mendeleev's gaps from his table of 1869, named from 1871", () => {
    const at = (symbol: string, year: number) =>
      lookOf(element(symbol), { ...view, mode: "discovery", year });
    expect(at("Ga", MENDELEEV_YEAR - 1)).toMatchObject({ known: false, prophecy: null });
    expect(at("Ga", MENDELEEV_YEAR)).toMatchObject({
      known: false,
      prophecy: "gap",
      tone: PREDICTION_TONE,
    });
    expect(at("Ga", MENDELEEV_NAMED)).toMatchObject({ prophecy: "eka-aluminium" });
    expect(at("Ga", 1875)).toMatchObject({ known: true, prophecy: null, fresh: true });
    expect(at("Ga", 1875 + FRESH_YEARS)).toMatchObject({ fresh: false });
  });

  it("leaves technetium out of the table of 1869, which had no room for it", () => {
    const at = (year: number) => lookOf(element("Tc"), { ...view, mode: "discovery", year });
    expect(at(MENDELEEV_YEAR)).toMatchObject({ prophecy: null });
    expect(at(MENDELEEV_NAMED)).toMatchObject({ prophecy: "eka-manganese" });
  });

  it("never calls an element known since antiquity new", () => {
    const gold = lookOf(element("Au"), { ...view, mode: "discovery", year: 1600 });
    expect(gold).toMatchObject({ known: true, fresh: false, badge: "ancient" });
  });
});

describe("electronegativityTone", () => {
  it("clamps past the ends", () => {
    expect(electronegativityTone(0)).toBe(EN_STOPS[0]);
    expect(electronegativityTone(9)).toBe(EN_STOPS[EN_STOPS.length - 1]);
  });
});

describe("the sliders", () => {
  it("turn a temperature into a position and back", () => {
    for (const kelvin of [0, 77, 298, 1811, 5772]) {
      expect(kelvinAt(positionOfKelvin(kelvin))).toBe(kelvin);
    }
  });

  it("turn a year into a position and back", () => {
    for (const year of [1600, 1869, 2026]) {
      expect(yearAt(positionOfYear(year))).toBe(year);
    }
  });
});
