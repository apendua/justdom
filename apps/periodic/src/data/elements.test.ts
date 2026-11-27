import { describe, expect, it } from "vitest";
import {
  ELEMENTS,
  MENDELEEV_PREDICTIONS,
  MENDELEEV_YEAR,
  phaseAt,
  placeOf,
  shellsOf,
} from "./elements";

describe("ELEMENTS", () => {
  it("has the 118 elements in order", () => {
    expect(ELEMENTS).toHaveLength(118);
    ELEMENTS.forEach((element, i) => expect(element.number).toBe(i + 1));
  });

  it("gives every element as many electrons as protons", () => {
    for (const element of ELEMENTS) {
      expect(
        element.shells.reduce((a, b) => a + b, 0),
        element.symbol,
      ).toBe(element.number);
    }
  });

  it("puts no two elements in one cell", () => {
    const cells = new Set(ELEMENTS.map((e) => `${e.column},${e.row}`));
    expect(cells.size).toBe(118);
  });

  it("never has an element melt above where it boils", () => {
    for (const { symbol, melts, boils } of ELEMENTS) {
      if (melts !== null && boils !== null) {
        expect(melts, symbol).toBeLessThanOrEqual(boils);
      }
    }
  });

  it("knew 63 elements in Mendeleev's year, as his table did", () => {
    expect(ELEMENTS.filter((e) => e.discovered <= MENDELEEV_YEAR)).toHaveLength(63);
  });

  it("has fluorine and not helium in Mendeleev's year, as his table of 1869 does", () => {
    const known = (symbol: string) =>
      ELEMENTS.find((e) => e.symbol === symbol)!.discovered <= MENDELEEV_YEAR;
    expect(known("F")).toBe(true);
    expect(known("He")).toBe(false);
  });

  it("has every element Mendeleev predicted found after he left room for it", () => {
    for (const [number, { gapSince }] of Object.entries(MENDELEEV_PREDICTIONS)) {
      expect(ELEMENTS[Number(number) - 1].discovered).toBeGreaterThan(gapSince);
    }
  });

  it("reads a mass with no decimals as a mass number", () => {
    expect(ELEMENTS[42].massIsotope).toBe(true); // technetium, [98]
    expect(ELEMENTS[25].massIsotope).toBe(false); // iron, 55.845
  });
});

describe("placeOf", () => {
  it.each([
    [1, 1, 1],
    [2, 18, 1],
    [5, 13, 2],
    [26, 8, 4],
    [56, 2, 6],
    [57, 3, 9],
    [71, 17, 9],
    [72, 4, 6],
    [86, 18, 6],
    [89, 3, 10],
    [104, 4, 7],
    [118, 18, 7],
  ])("puts element %i in column %i, row %i", (number, column, row) => {
    expect(placeOf(number)).toMatchObject({ column, row });
  });

  it("says which period an f-block element is in", () => {
    expect(placeOf(92).period).toBe(7);
  });
});

describe("shellsOf", () => {
  it("expands a noble gas core", () => {
    expect(shellsOf("[Ar] 3d6 4s2")).toEqual([2, 8, 14, 2]);
  });

  it("counts a subshell into its own shell, not the order it fills in", () => {
    expect(shellsOf("[Xe] 4f14 5d10 6s1")).toEqual([2, 8, 18, 32, 18, 1]);
  });

  it("refuses what it cannot read", () => {
    expect(() => shellsOf("[Zz] 1s1")).toThrow();
    expect(() => shellsOf("1x2")).toThrow();
  });
});

describe("phaseAt", () => {
  const [hydrogen, helium] = ELEMENTS;
  const carbon = ELEMENTS[5];
  const mercury = ELEMENTS[79];
  const fermium = ELEMENTS[99];
  const rutherfordium = ELEMENTS[103];

  it("follows the melting and boiling points", () => {
    expect(phaseAt(mercury, 200)).toBe("solid");
    expect(phaseAt(mercury, 298)).toBe("liquid");
    expect(phaseAt(mercury, 700)).toBe("gas");
    expect(phaseAt(hydrogen, 298)).toBe("gas");
  });

  it("takes a sublimation point straight from solid to gas", () => {
    expect(phaseAt(carbon, 3914)).toBe("solid");
    expect(phaseAt(carbon, 3915)).toBe("gas");
  });

  it("keeps helium liquid down to absolute zero", () => {
    expect(phaseAt(helium, 0)).toBe("liquid");
  });

  it("calls a melt with no known boiling point a liquid", () => {
    expect(phaseAt(fermium, 5000)).toBe("liquid");
  });

  it("knows nothing of an element with neither figure", () => {
    expect(phaseAt(rutherfordium, 298)).toBeNull();
  });
});
