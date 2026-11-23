import { type Element, MENDELEEV_PREDICTIONS, phaseAt } from "./data/elements";

/**
 * An element's figures as the popup and the inspector write them, so the
 * two never disagree on a unit or a blank.
 */

export const BLANK = "unknown";

export function massText(element: Element): string {
  return element.massIsotope ? `[${element.mass}]` : String(element.mass);
}

export function kelvinText(kelvin: number | null): string {
  if (kelvin === null) {
    return BLANK;
  }
  const celsius = kelvin - 273.15;
  return `${Math.round(celsius).toLocaleString("en-US")} °C`;
}

export function densityText(element: Element): string {
  const { density } = element;
  if (density === null) {
    return BLANK;
  }
  // A gas's density reads better per litre: 0.09 g/L rather than 0.00009 g/cm³.
  return density < 0.02
    ? `${(density * 1000).toPrecision(3)} g/L`
    : `${density.toPrecision(3)} g/cm³`;
}

export function discoveredText(element: Element): string {
  return element.discovered === 0 ? "Antiquity" : String(element.discovered);
}

export function phaseText(element: Element, kelvin: number): string {
  return phaseAt(element, kelvin) ?? BLANK;
}

/** The one line about an element that is worth a popup of its own, if any. */
export function noteOf(element: Element): string | null {
  const prophecy = MENDELEEV_PREDICTIONS[element.number];
  if (prophecy) {
    return `Foretold by Mendeleev in 1869 as ${prophecy}.`;
  }
  if (element.melts === element.boils && element.melts !== null) {
    return "Turns straight from solid to gas.";
  }
  if (element.number === 2) {
    return "Stays liquid down to absolute zero.";
  }
  if (element.predicted) {
    return "Made a few atoms at a time; its chemistry is predicted.";
  }
  return null;
}
