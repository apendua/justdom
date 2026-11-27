import {
  type Element,
  MENDELEEV_NAMED,
  MENDELEEV_PREDICTIONS,
  phaseAt,
  ROOM_KELVIN,
} from "./data/elements";
import { formatKelvin, type View } from "./looks";

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

/**
 * Where it melts. An element known to boil but with no melting point is one
 * no cold freezes at one atmosphere, which is helium.
 */
export function meltsText(element: Element): string {
  if (element.melts === null && element.boils !== null) {
    return "none at 1 atm";
  }
  return kelvinText(element.melts);
}

export function electronegativityText(element: Element): string {
  return element.electronegativity?.toFixed(2) ?? BLANK;
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

/** The temperature the state is told at: the state view's, or room temperature. */
function stateKelvin(view: View): number {
  return view.mode === "phase" ? view.kelvin : ROOM_KELVIN;
}

/** What the state is told under: `At 1811 K · 1538 °C`, or `At room temperature`. */
export function stateCaption(view: View): string {
  return view.mode === "phase" ? `At ${formatKelvin(view.kelvin)}` : "At room temperature";
}

export function phaseText(element: Element, view: View): string {
  return phaseAt(element, stateKelvin(view)) ?? BLANK;
}

/** The one line about an element that is worth a popup of its own, if any. */
export function noteOf(element: Element): string | null {
  const prediction = MENDELEEV_PREDICTIONS[element.number];
  if (prediction) {
    return prediction.gapSince < MENDELEEV_NAMED
      ? `Left as a gap by Mendeleev in ${prediction.gapSince}, named ${prediction.name} in ${MENDELEEV_NAMED}.`
      : `Predicted by Mendeleev in ${MENDELEEV_NAMED} as ${prediction.name}.`;
  }
  if (element.melts === element.boils && element.melts !== null) {
    return "Turns straight from solid to gas.";
  }
  if (element.number === 2) {
    return "Seen in the Sun in 1868; stays liquid down to absolute zero.";
  }
  if (element.predicted) {
    return "Made a few atoms at a time; its chemistry is predicted.";
  }
  return null;
}
