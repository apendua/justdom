/**
 * What every part of the table shares: the type, the inks and the surfaces.
 * A system face, since a web font is one more thing a panel's measuring has
 * to wait for, and nothing here needs one.
 */
export const FONT = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** The page and the room a session is set against. */
export const NIGHT = "#0a0f1f";
export const SURFACE = "#121a30";
export const SURFACE_RAISED = "#1a2440";
export const EDGE = "#2a3658";
export const INK = "#eef2ff";
export const DIM = "#9aa6c6";
export const FAINT = "#64708f";

/** A tone with an alpha, as `#rrggbbaa`, for a tile's tinted background. */
export const tint = (tone: string, alpha: number) =>
  `${tone}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;

/**
 * What makes a control a control: `cursor: pointer` is also what makes an
 * element a target of the headset's ray.
 */
export const pressable = `
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
`;
