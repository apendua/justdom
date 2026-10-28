import { LOOKS } from "../looks.js";

/**
 * The scenes of the paint-order probe (`paint-order-probe.html`), one a
 * page, picked by `?scene=`: each the panels one row of the Quest's half of
 * phase 4 in `docs/freedom-paint-order-plan.md` looks at, and what the
 * probe's Action button does to them, if it does anything. A scene with no
 * action, such as `hover`, is worked by the person in the headset while
 * Record records.
 *
 * The panels are plain elements on the page, laid out by the browser, and
 * mirrored where the scene places them. Sizes are in px, and a panel's
 * `scale` is metres a px. The reference space is `local`, so the head
 * starts at the origin looking down -z.
 */

/** Where a panel stands, in metres and radians. */
export interface Place {
  x: number;
  y: number;
  z: number;
  /** Tipped about x: positive turns the top away. */
  rx?: number;
  /** Turned about y: positive turns the right edge away. */
  ry?: number;
  /** Metres a px. */
  scale: number;
}

export interface ProbePanel {
  element: HTMLElement;
  place: Place;
  /** Mounted by the Action button rather than when the session starts. */
  later?: boolean;
}

export interface ProbeScene {
  name: string;
  /** What to look at, shown on the page and on the control panel. */
  what: string;
  panels: ProbePanel[];
  /**
   * What the Action button is labelled and does, if anything. `mountLater`
   * mounts every panel marked `later`. The probe records one press at a
   * time, and refuses a press while a run records; once `mountLater` has
   * run, it refuses every press: a panel mounts once a page.
   */
  action?: { label: string; run(mountLater: () => void): void };
  /** A second button, for an action that repeats until pressed again. */
  loop?: { label: string; run(): void };
  /** A stylesheet the scene's panels are drawn by, put on the page. */
  style?: string;
  /** A stylesheet of web fonts the scene's panels are drawn in, linked. */
  fonts?: string;
  /**
   * Notes on the first panel that a run follows frame by frame
   * (`trace.ts`), each with the angle in degrees it is tilted by, which no
   * two share.
   */
  notes?: { elements: HTMLElement[]; tilts: number[] };
}

/** A millimetre a px. */
const MM = 0.001;

const COLOURS = ["#e8f1ff", "#ffe9d6", "#e3f7e6", "#fbe3f0", "#fff6c9", "#e6e3fb"];

/**
 * An element with inline style and children, which the probe's scenes are
 * written in.
 */
function el(tag: string, style: string, ...children: (Node | string)[]): HTMLElement {
  const element = document.createElement(tag);
  element.setAttribute("style", style);
  element.append(...children);
  return element;
}

/** A panel's root: a box of a size, laid out on its own. */
function root(width: number, height: number, background = "#d9dce3"): HTMLElement {
  return el(
    "div",
    `position: relative; width: ${width}px; height: ${height}px; background: ${background};` +
      " border-radius: 12px; font: 22px/1.2 system-ui, sans-serif; color: #1b1e27;" +
      " overflow: hidden",
  );
}

/** An opaque card with a label, absolutely placed in its parent. */
function card(
  label: string,
  [left, top, width, height]: [number, number, number, number],
  colour: string,
  extra = "",
): HTMLElement {
  return el(
    "div",
    `position: absolute; left: ${left}px; top: ${top}px; width: ${width}px;` +
      ` height: ${height}px; background: ${colour}; border: 2px solid #3a4152;` +
      ` border-radius: 8px; padding: 6px 10px; box-sizing: border-box; ${extra}`,
    label,
  );
}

/** Set an element's transform, or take it off, by its transition. */
function toggle(element: HTMLElement, transform: string): void {
  element.style.transform = element.style.transform ? "" : transform;
}

/**
 * Run `step` every `ms` until called again, for a loop button.
 *
 * @returns The loop's own `run`.
 */
function every(ms: number, step: () => void): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    } else {
      step();
      timer = setInterval(step, ms);
    }
  };
}

/**
 * The 100-card piled board, the GPU row's second scene: every card over the
 * one before, each a layer of draws in the lift build.
 */
function pile(): ProbeScene {
  const board = root(900, 700);
  for (let i = 0; i < 100; i += 1) {
    board.append(card(`${i + 1}`, [30 + i * 6, 30 + i * 5, 200, 120], COLOURS[i % COLOURS.length]));
  }
  return {
    name: "pile",
    what: "100 opaque cards piled, each over the one before. Time it with OVR Metrics Tool.",
    panels: [{ element: board, place: { x: 0, y: 0, z: -0.8, scale: MM } }],
  };
}

/** A card swung by `rotateY(30deg)` about its centre, in a panel of its own. */
function swungPanel(): HTMLElement {
  const panel = root(600, 400);
  panel.append(
    card("swung 30°", [150, 100, 300, 200], COLOURS[1], "transform: rotateY(30deg)"),
    card("flat, later", [60, 260, 200, 100], COLOURS[2]),
  );
  return panel;
}

/** A panel holding a swung card, mounted by the Action button mid-session. */
function mount(): ProbeScene {
  return {
    name: "mount",
    what: "Action mounts a panel holding a swung card, as a menu opened in the headset does.",
    panels: [{ element: swungPanel(), place: { x: 0, y: 0, z: -0.8, scale: MM }, later: true }],
    action: { label: "Mount the panel", run: (mountLater) => mountLater() },
  };
}

/** A card inside a swung card, flipped by a transition. */
function flip(): ProbeScene {
  const panel = root(600, 400);
  const outer = card("swung 30°", [100, 60, 400, 280], COLOURS[0], "transform: rotateY(30deg)");
  const inner = card("inner", [100, 80, 200, 120], COLOURS[3], "transition: transform 1s ease");
  outer.append(inner);
  panel.append(outer);
  const run = () => toggle(inner, "rotateY(30deg)");
  return {
    name: "flip",
    what: "Action flips the inner card of a swung card, none to rotateY(30deg) and back.",
    panels: [{ element: panel, place: { x: 0, y: 0, z: -0.8, scale: MM } }],
    action: { label: "Flip the inner card", run },
    loop: { label: "Flip every 1.5 s", run: every(1500, run) },
  };
}

/** A third level that swings in a panel mounted with nothing swung. */
function third(): ProbeScene {
  const panel = root(600, 400);
  const first = card("level 1", [50, 30, 500, 340], COLOURS[0]);
  const second = card("level 2", [50, 50, 400, 240], COLOURS[1]);
  const level3 = card("level 3", [100, 60, 200, 120], COLOURS[2], "transition: transform 1s ease");
  second.append(level3);
  first.append(second);
  panel.append(first);
  return {
    name: "third",
    what: "Action swings the third level of three flat cards by rotateY(30deg), and back.",
    panels: [{ element: panel, place: { x: 0, y: 0, z: -0.8, scale: MM } }],
    action: { label: "Swing level 3", run: () => toggle(level3, "rotateY(30deg)") },
  };
}

/**
 * A card tilted `degrees` from its parent's plane, its left half towards
 * the viewer, and a later sibling over that half.
 */
function tiltPair(degrees: number, top: number): HTMLElement[] {
  return [
    card(
      `${degrees}°: left half nearer`,
      [40, top, 300, 160],
      COLOURS[4],
      `transform: rotateY(${degrees}deg)`,
    ),
    card("later sibling", [20, top + 40, 170, 80], COLOURS[5]),
  ];
}

/**
 * Cards 2° and 5° from their parent's plane, on the opaque root and inside
 * a translucent overlay, each with a later sibling over its forward half.
 */
function tilts(): ProbeScene {
  const panel = root(800, 460);
  const overlay = el(
    "div",
    "position: absolute; left: 420px; top: 20px; width: 360px; height: 420px; z-index: 1;" +
      " background: rgba(255, 255, 255, 0.6); border-radius: 10px",
  );
  const pairs = [tiltPair(2, 30), tiltPair(5, 230), tiltPair(2, 30), tiltPair(5, 230)];
  overlay.append(...pairs[2], ...pairs[3]);
  panel.append(
    el("div", "position: absolute; left: 20px; top: 2px; font-size: 16px", "opaque root"),
    el("div", "position: absolute; left: 440px; top: 2px; font-size: 16px", "translucent overlay"),
    ...pairs[0],
    ...pairs[1],
    overlay,
  );
  const siblings = pairs.map(([, sibling]) => sibling);
  return {
    name: "tilts",
    what:
      "Cards 2° and 5° from the panel, left half nearer: on the left on the opaque root, on" +
      ` the right in a translucent overlay. A later sibling covers each left half. Action` +
      ` raises the siblings ${RAISE} px, where each tilted card passes through them.`,
    panels: [{ element: panel, place: { x: 0, y: 0, z: -0.7, scale: MM } }],
    action: {
      label: `Raise the siblings ${RAISE} px`,
      run: () => siblings.forEach((sibling) => toggle(sibling, `translateZ(${RAISE}px)`)),
    },
  };
}

/**
 * How far `tilts`' Action raises the siblings off the panel, in px: less
 * than the tilted cards' left edges stand off it, about 5 px at 2° and 13 px
 * at 5°, so that each card passes through its sibling, at about x = 104 px
 * at 2° and x = 156 px at 5°, both over the sibling's 20 to 190.
 */
const RAISE = 3;

/** 10.1's poses: facing, turned 15° and tipped 45° and 75°. */
const POSES: { label: string; rx: number; ry: number }[] = [
  { label: "facing", rx: 0, ry: 0 },
  { label: "turned 15°", rx: 0, ry: (15 * Math.PI) / 180 },
  { label: "tipped 45°", rx: (45 * Math.PI) / 180, ry: 0 },
  { label: "tipped 75°", rx: (75 * Math.PI) / 180, ry: 0 },
];

const DISTANCES = [1, 5, 10];

/**
 * Piles of six labelled cards in 10.1's poses at 1, 5 and 10 m, each panel
 * scaled with its distance so that every pile looks the same size.
 */
function piles(): ProbeScene {
  const panels: ProbePanel[] = [];
  DISTANCES.forEach((distance, row) => {
    POSES.forEach((pose, column) => {
      const panel = root(300, 230, "#c9ccd4");
      panel.append(el("div", "padding: 4px 8px; font-size: 16px", `${pose.label}, ${distance} m`));
      for (let i = 0; i < 6; i += 1) {
        panel.append(
          card("ABCDEF"[i], [20 + i * 14, 34 + i * 12, 160, 100], COLOURS[i % COLOURS.length]),
        );
      }
      panels.push({
        element: panel,
        place: {
          x: (column - 1.5) * 0.36 * distance,
          y: (1 - row) * 0.28 * distance,
          z: -distance,
          rx: pose.rx,
          ry: pose.ry,
          scale: MM * distance,
        },
      });
    });
  });
  return {
    name: "piles",
    what:
      "Piles of cards A to F, F on top, in 10.1's poses at 1, 5 and 10 m: rows by distance," +
      " columns by pose.",
    panels,
  };
}

/** A card turning through a whole turn, frozen edge-on by the Action button. */
function flip90(): ProbeScene {
  const panel = root(600, 400);
  const turning = card(
    "turning",
    [150, 100, 300, 200],
    COLOURS[0],
    "animation: probe-turn 6s linear infinite",
  );
  panel.append(card("behind", [60, 140, 480, 120], COLOURS[2]), turning);
  return {
    name: "flip90",
    what:
      "A card turning about y. Action freezes it at 90°, edge-on, and Capture eyes reads back" +
      " both eyes' images in one frame.",
    panels: [{ element: panel, place: { x: 0, y: 0, z: -0.8, scale: MM } }],
    action: {
      label: "Freeze edge-on",
      run: () => {
        const frozen = turning.style.animationName === "none";
        turning.style.animationName = frozen ? "probe-turn" : "none";
        turning.style.transform = frozen ? "" : "rotateY(90deg)";
      },
    },
  };
}

/** Where `hover`'s cards are pinned, and how far each is turned. */
const PINNED: { left: number; top: number; tilt: number }[] = [
  { left: 40, top: 40, tilt: -4 },
  { left: 230, top: 30, tilt: 3 },
  { left: 420, top: 50, tilt: -2 },
  { left: 610, top: 35, tilt: 5 },
  { left: 60, top: 250, tilt: 2 },
  { left: 250, top: 260, tilt: -5 },
  { left: 440, top: 240, tilt: 4 },
  { left: 630, top: 255, tilt: -3 },
];

/** The colours of Beige Box's notes, by their class. */
const NOTES = ["green", "pink", ""];

/**
 * Notes pinned on a corkboard that rise when hovered: Beige Box's own,
 * made as Beige Box makes a new note, from its `#note-template`, and drawn
 * by its stylesheet and fonts, which the scene loads, so that what is
 * measured is what Beige Box does. Beige Box's cards stop for a moment as
 * the pointer comes onto them, and here they are on their own. The notes
 * are draggable, as the template's are, which makes each a ray target and
 * so hovered.
 */
function hover(): ProbeScene {
  const look = LOOKS.find(({ id }) => id === "beige");
  if (!look) {
    throw new Error("there is no Beige Box look to take the corkboard from");
  }
  const page = new DOMParser().parseFromString(look.markup, "text/html");
  const template = page.querySelector<HTMLTemplateElement>("#note-template");
  const made = template?.content.firstElementChild;
  if (!made) {
    throw new Error("Beige Box's markup has no #note-template");
  }
  const board = el("div", "width: 820px");
  board.className = "cork";
  const notes = PINNED.map(({ left, top, tilt }, i) => {
    const note = made.cloneNode(true) as HTMLElement;
    note.classList.remove("green");
    if (NOTES[i % NOTES.length]) {
      note.classList.add(NOTES[i % NOTES.length]);
    }
    note.style.cssText = `left: ${left}px; top: ${top}px; --tilt: ${tilt}deg`;
    const text = note.querySelector("[data-note-text]");
    if (text) {
      text.textContent = `note ${i + 1}`;
    }
    board.append(note);
    return note;
  });
  return {
    name: "hover",
    what:
      "Beige Box's corkboard notes, each raised by Beige Box's own rule while hovered. Press" +
      " Record and move the ray over them one by one.",
    panels: [{ element: board, place: { x: 0, y: 0, z: -0.7, scale: MM } }],
    style: look.style,
    fonts: look.fonts,
    notes: { elements: notes, tilts: PINNED.map(({ tilt }) => tilt) },
  };
}

/** The keyframes `flip90` turns by, once on the page. */
export const PROBE_CSS =
  "@keyframes probe-turn { from { transform: rotateY(0deg) } to { transform: rotateY(360deg) } }";

/**
 * Two panels crossing each other, one facing and one turned 35° about its
 * vertical middle, through the same point: each half of one is in front of
 * the other, as a panel the hand carries into another is.
 */
function cross(): ProbeScene {
  const facing = root(400, 300, "#cfe0ff");
  facing.append(card("facing", [40, 40, 320, 220], COLOURS[0]));
  const turned = root(400, 300, "#ffd9b3");
  turned.append(card("turned 35°", [40, 40, 320, 220], COLOURS[1]));
  return {
    name: "cross",
    what: "Two panels crossing through their middles, one facing and one turned 35°.",
    panels: [
      { element: facing, place: { x: 0, y: 0, z: -0.7, scale: MM } },
      { element: turned, place: { x: 0, y: 0, z: -0.7, ry: (35 * Math.PI) / 180, scale: MM } },
    ],
  };
}

export const SCENES: Record<string, () => ProbeScene> = {
  pile,
  mount,
  flip,
  third,
  tilts,
  piles,
  flip90,
  hover,
  cross,
};
