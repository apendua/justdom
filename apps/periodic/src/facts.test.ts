import { describe, expect, it } from "vitest";
import { ELEMENTS } from "./data/elements";
import { meltsText, noteOf, phaseText, stateCaption } from "./facts";

const element = (symbol: string) => {
  const found = ELEMENTS.find((e) => e.symbol === symbol);
  if (!found) throw new Error(symbol);
  return found;
};

describe("noteOf", () => {
  it("says a gap of 1869 was named in 1871", () => {
    expect(noteOf(element("Ga"))).toBe(
      "Left as a gap by Mendeleev in 1869, named eka-aluminium in 1871.",
    );
  });

  it("says eka-manganese was predicted in 1871", () => {
    expect(noteOf(element("Tc"))).toBe("Predicted by Mendeleev in 1871 as eka-manganese.");
  });
});

describe("meltsText", () => {
  it("says helium has no melting point at one atmosphere", () => {
    expect(meltsText(element("He"))).toBe("none at 1 atm");
  });

  it("calls an unmeasured melting point unknown", () => {
    expect(meltsText(element("Rf"))).toBe("unknown");
  });
});

describe("the state line", () => {
  it("is at room temperature outside the state view", () => {
    const view = { mode: "category", kelvin: 5772, year: 2026 } as const;
    expect(stateCaption(view)).toBe("At room temperature");
    expect(phaseText(element("Hg"), view)).toBe("liquid");
  });

  it("is at the state view's temperature in it", () => {
    const view = { mode: "phase", kelvin: 1000, year: 2026 } as const;
    expect(stateCaption(view)).toBe("At 1000 K · 727 °C");
    expect(phaseText(element("Hg"), view)).toBe("gas");
  });
});
