import type { PortalPlugin } from "justdom-three";
import BoxesPanel from "./BoxesPanel.js";
import BackgroundsPanel from "./BackgroundsPanel.js";
import PseudoPanel from "./PseudoPanel.js";
import PaintOrderPanel from "./PaintOrderPanel.js";
import TextPanel from "./TextPanel.js";
import ListsPanel from "./ListsPanel.js";
import ImagesPanel from "./ImagesPanel.js";
import SvgPanel from "./SvgPanel.js";
import SvgPaintPanel from "./SvgPaintPanel.js";
import MotionPanel from "./MotionPanel.js";
import PointerPanel from "./PointerPanel.js";
import FormsPanel from "./FormsPanel.js";
import WidgetsPanel from "./WidgetsPanel.js";

/**
 * One panel of the deck: what the switcher calls it, what builds it, and how
 * its portal is set up.
 */
export interface PanelEntry {
  /**
   * What `?panel=` and `window.__showcase.show()` name it by, and what its
   * photograph in the visual suite is called.
   */
  readonly id: string;
  /** What the switcher shows. */
  readonly title: string;
  readonly component: typeof BoxesPanel;
  /**
   * Whether the portal lands an update whole (see `PortalOptions.atomic`).
   * Off for a panel whose transition, started by a click, invalidates it on
   * every frame: instalments that move beat a whole update that jumps, for
   * something under the player's hand.
   */
  readonly atomic?: boolean;
  /**
   * Whether the player can pick the panel up by the strips along its edges
   * and carry it (see `PortalOptions.draggable`). Off unless a panel says so.
   */
  readonly draggable?: boolean;
  /**
   * Portal plugins this panel needs, loaded the first time it is shown. The
   * panel is mounted once they have loaded, so a deck that never shows it
   * never fetches them.
   */
  readonly plugins?: () => Promise<readonly PortalPlugin[]>;
}

/**
 * The SVG plugin, fetched once, by the first panel that asks. It is a
 * separate entry point so that a scene without an SVG in it never loads
 * three's `SVGLoader` or the stroking and dashing built on it.
 */
let svgPlugin: Promise<readonly PortalPlugin[]> | undefined;
const loadSvgPlugin = () =>
  (svgPlugin ??= import("justdom-three/svg").then(({ svgElements }) => [svgElements()]));

/**
 * The deck, in the order the switcher steps through it. Each panel covers one
 * area of what a portal can draw, and the visual suite photographs each one.
 */
export const PANELS = [
  { id: "boxes", title: "Boxes", component: BoxesPanel, atomic: false },
  { id: "backgrounds", title: "Backgrounds", component: BackgroundsPanel },
  { id: "pseudo", title: "Before & after", component: PseudoPanel },
  { id: "paint-order", title: "Paint order", component: PaintOrderPanel },
  { id: "text", title: "Text", component: TextPanel },
  { id: "lists", title: "Lists", component: ListsPanel },
  { id: "images", title: "Images", component: ImagesPanel },
  { id: "svg", title: "Vectors", component: SvgPanel, plugins: loadSvgPlugin },
  { id: "svg-paint", title: "SVG paint", component: SvgPaintPanel, plugins: loadSvgPlugin },
  { id: "motion", title: "Motion", component: MotionPanel },
  { id: "pointer", title: "Pointer", component: PointerPanel, atomic: false },
  { id: "forms", title: "Forms", component: FormsPanel },
  { id: "widgets", title: "Widgets", component: WidgetsPanel, draggable: true },
] as const satisfies readonly PanelEntry[];

export type PanelId = (typeof PANELS)[number]["id"];

export type Panel = (typeof PANELS)[number];

/** The panel an id names, or undefined for one the deck does not have. */
export function findPanel(id: PanelId): Panel;
export function findPanel(id: string | null): Panel | undefined;
export function findPanel(id: string | null): Panel | undefined {
  return PANELS.find((panel) => panel.id === id);
}

/**
 * The panel `by` places after `id` in the deck, or before it for a negative
 * `by`, wrapping around at either end: what Prev and Next step to.
 */
export function stepFrom(id: PanelId, by: number): PanelId {
  const index = PANELS.findIndex((panel) => panel.id === id);
  return PANELS[(index + by + PANELS.length) % PANELS.length].id;
}

/** The portal plugins a panel needs, loaded; none for a panel that needs none. */
export async function loadPlugins(panel: Panel): Promise<readonly PortalPlugin[]> {
  return "plugins" in panel ? panel.plugins() : [];
}
