import type { PortalOptions } from "justdom-three";
import type { Phosphor } from "./terminal.js";
import beigeMarkup from "./looks/beige.html?raw";
import beigeStyle from "./looks/beige.css?inline";
import opsMarkup from "./looks/ops.html?raw";
import opsStyle from "./looks/ops.css?inline";
import paperMarkup from "./looks/paper.html?raw";
import paperStyle from "./looks/paper.css?inline";

/**
 * Where one object of the page stands in the room. `x`, `y` and `z` are
 * the middle of the panel; `y` is measured up from the desk's top. `facing`
 * turns it about the vertical to face the viewer from where it stands, and
 * `lying` lays it down on the desk, tipped up toward the viewer by `tilt`.
 */
export interface Placement {
  id: string;
  x: number;
  y: number;
  z: number;
  facing?: boolean;
  lying?: boolean;
  tilt?: number;
  /** A turn about the panel's own normal, for something lying askew. */
  roll?: number;
  /** Metres per desk px, if not the scene's default. */
  px?: number;
  options?: Omit<PortalOptions, "root">;
}

/** The colours of the room a look is set in, taken from its page. */
export interface Room {
  wall: string;
  top: string;
  legs: string;
  floor: string;
  /** The sky all round, which an AR session clears to. */
  backdrop: string;
}

/** One of the desks: its page, and how it is set out in a headset. */
export interface Look {
  id: "beige" | "ops" | "paper";
  name: string;
  /** What goes inside `.desk`: the zones and the templates they use. */
  markup: string;
  style: string;
  fonts: string;
  /** The program the monitor loads when the look is put up. */
  boot: string;
  phosphor: Phosphor;
  room: Room;
  /** The zones mirrored in a session, and where each one stands. */
  placements: readonly Placement[];
  /** Whether the room has the mug on the desk, a mesh rather than a panel. */
  mug?: boolean;
}

/**
 * The height of the desk's top, below the eyes, in metres. The scene sets
 * the room out from it, and `tests/xr-check.mjs` aims at the panels by it.
 */
export const DESK_TOP = -0.42;

/**
 * How big a desk px is in the room: 0.65 mm, which makes the keyboard 43 cm
 * across, about what the real one was. The monitor is drawn bigger than that
 * (`MONITOR_SCALE`). A portal draws a px a centimetre, so a panel is scaled
 * by this over 0.01.
 */
export const PX = 0.00065;

const degrees = (value: number) => (value * Math.PI) / 180;

/** How much bigger the monitor is drawn in the room than its px. */
const MONITOR_SCALE = 1.5;

// The objects every look has in the same place: the monitor on the desk,
// the keyboard lying in front of it, raised at the back as keyboards are.
// Its centre rises with its size, so that it still stands on the desk.
const monitor: Placement = {
  id: "monitor",
  x: 0,
  y: 0.168 * MONITOR_SCALE,
  z: -0.78,
  px: PX * MONITOR_SCALE,
};
const keyboard: Placement = {
  id: "keyboard",
  x: 0,
  y: 0.014,
  z: -0.47,
  lying: true,
  tilt: degrees(9),
};

/**
 * The panels either side of the monitor, turned in toward the chair. They
 * are read rather than used, so they are drawn bigger than the monitor's px,
 * about the size of a poster each, and can be carried.
 */
const side = (id: string, x: number, y: number): Placement => ({
  id,
  x,
  y,
  z: -0.62,
  px: 0.00095,
  facing: true,
  options: { draggable: true },
});

/**
 * What the monitor loads from, lying to the left of the keyboard. Between
 * the pieces is the desk, which a ray should reach.
 */
const media = (id: string): Placement => ({
  id,
  x: -0.4,
  y: 0.002,
  z: -0.44,
  lying: true,
  options: { opaqueToRays: false, loadingFrame: false },
});

/**
 * The paper lying askew to the right, which can be picked up and tipped to
 * read: `level: false` hands it the hand's whole rotation.
 */
const paper: Placement = {
  id: "memo",
  x: 0.37,
  y: 0.003,
  z: -0.44,
  lying: true,
  roll: degrees(6),
  options: { draggable: { level: false } },
};

/** Something on the wall above the monitor, bigger than on the page. */
const onWall = (id: string, px: number): Placement => ({
  id,
  x: 0,
  y: 0.68,
  z: -1.19,
  px,
  options: { opaqueToRays: false, loadingFrame: false },
});

export const LOOKS: readonly Look[] = [
  {
    id: "beige",
    name: "Beige Box '84",
    markup: beigeMarkup,
    style: beigeStyle,
    fonts:
      "https://fonts.googleapis.com/css2?family=VT323&family=Caveat:wght@500;700&family=Cinzel:wght@600;700&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;600&family=Zen+Dots&display=swap",
    boot: "DESK.JS",
    phosphor: "green",
    room: {
      wall: "#1b3331",
      top: "#8a5a33",
      legs: "#5e3a1e",
      floor: "#141c1b",
      backdrop: "#0f1716",
    },
    placements: [
      monitor,
      keyboard,
      side("charts", -0.58, 0.3),
      side("board", 0.58, 0.25),
      media("floppies"),
      paper,
      onWall("clock", 0.0015),
    ],
    mug: true,
  },
  {
    id: "ops",
    name: "Night Ops",
    markup: opsMarkup,
    style: opsStyle,
    fonts:
      "https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Permanent+Marker&family=Oswald:wght@500;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,700;1,8..60,400&family=JetBrains+Mono:wght@500;700&display=swap",
    boot: "REVEAL.FRAG",
    phosphor: "amber",
    room: {
      wall: "#1d222c",
      top: "#2f343c",
      legs: "#15171b",
      floor: "#0e1014",
      backdrop: "#0b0d11",
    },
    placements: [
      monitor,
      keyboard,
      side("charts", -0.58, 0.31),
      side("board", 0.58, 0.26),
      media("tapes"),
      paper,
      onWall("clocks", 0.0011),
    ],
  },
  {
    id: "paper",
    name: "Paper Studio",
    markup: paperMarkup,
    style: paperStyle,
    fonts:
      "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600&family=Caveat:wght@500;700&family=Fraunces:opsz,wght@9..144,600;9..144,800&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&family=Noto+Serif+Hebrew:wght@400;600&family=Space+Grotesk:wght@500;700&display=swap",
    boot: "DESK.JS",
    phosphor: "green",
    room: {
      wall: "#b8b3a5",
      top: "#c9ad7c",
      legs: "#9c7f52",
      floor: "#8f8778",
      backdrop: "#a9a597",
    },
    placements: [
      monitor,
      keyboard,
      side("charts", -0.58, 0.31),
      side("board", 0.58, 0.27),
      media("carts"),
      paper,
      // The plant stands in the corner of the desk, behind the letter.
      {
        id: "plant",
        x: 0.64,
        y: 0.12,
        z: -0.3,
        px: 0.0012,
        facing: true,
        options: { opaqueToRays: false, loadingFrame: false },
      },
    ],
  },
];

/** The look a page opens with when its address names none it knows. */
export const DEFAULT_LOOK: Look = LOOKS[0];

/** The look named by `?look=`, or the default. */
export function lookFromSearch(search: string): Look {
  const id = new URLSearchParams(search).get("look");
  return LOOKS.find((look) => look.id === id) ?? DEFAULT_LOOK;
}
