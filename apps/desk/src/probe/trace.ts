import * as THREE from "three";

/**
 * A frame-by-frame account of a run, for what the frame intervals alone
 * cannot tell apart: a frame that was slow, and a card that did not move
 * when it should have.
 *
 * Each row says how long the frame's callbacks took and how much of that
 * was the draw, how long since the page itself was last rendered, and, for
 * a scene of notes (`hover`), where each note that is moving is: how far it
 * has risen on the page, by its computed style, and in the scene, by its
 * object, with the animations running on it. Inside a session the Quest
 * stops rendering the page, so its transitions stop advancing and fire no
 * events, and freedom has to find and advance them itself
 * (`animationClock.js`); the emulator keeps rendering the page and never
 * takes that path. A note that rises on the page and not in the scene, or
 * in neither, is what to look for.
 *
 * The trace is not a bystander to that. Reading a note's computed style
 * and its animations brings the page's styles up to date every frame,
 * which is where a suspended page creates the transition a hover starts,
 * so it can create one sooner than freedom alone would have. A run that
 * shows no lag may owe that to the trace. So the page's side is read only
 * when asked for (`pageReads`); without it a row has the scene's side,
 * which is read off the objects and touches no style.
 *
 * Each row can also name the panels that have work for a coming frame,
 * by freedom's `data-xr-busy` on their elements: an animation its clock
 * samples, or an update it has yet to draw. A panel that stays busy after
 * its notes have stopped moving on the page is one holding an update back.
 */

/** One frame. */
export interface TraceRow {
  /** Ms since the run's first frame. */
  t: number;
  /**
   * Ms the session's frame callbacks took since the row before, the draw
   * and the trace's own sampling included.
   */
  frameMs: number;
  /** Of that, ms in `renderer.render`. */
  renderMs: number;
  /** Of that, ms this trace took to sample the frame. */
  traceMs: number;
  /**
   * Ms since the page was last rendered: since a `requestAnimationFrame`
   * of the window was last answered. freedom counts the page as no longer
   * rendered past 200 ms (`renderingUpdates.js`).
   */
  pageFrameAgeMs: number;
  /** The note the ray is on, by its index on the board, or -1. */
  hovered: number;
  /** The panels with work for a coming frame, by name. */
  busy: string[];
  /** The notes that are risen or animating, on the page or in the scene. */
  notes: NoteRow[];
}

/** One note in one frame. */
export interface NoteRow {
  i: number;
  /**
   * How far the note has risen on the page, in px: its transform's z, or
   * null when the page is not read.
   */
  pageLift: number | null;
  /**
   * How far its object has risen in the scene, in px, from where it stood
   * when the run found it, or null when it was not found. Under the
   * emulator a note that rises 8 px on the page settles at 8 here in paint
   * order. The stack's bias build, measured there, put it at 10.
   */
  sceneLift: number | null;
  /** The animations on the note and in it, or null when not read. */
  animations: AnimationRow[] | null;
}

/** One animation. */
export interface AnimationRow {
  playState: AnimationPlayState;
  /**
   * Whether it has a start time: whether the timeline carries it. One
   * started while the page is not rendered has none until something
   * advances it by hand.
   */
  anchored: boolean;
  /** Ms into it, or null. */
  currentTime: number | null;
}

/** What the session's frames have cost since the last sample. */
const spent = { frame: 0, render: 0 };
/** When a frame of the window was last answered. */
let pageFrameAt = performance.now();

/**
 * Keep a frame of the window asked for, and note when each is answered.
 * One outstanding request at a time, as freedom keeps.
 */
function watchPageFrames(): void {
  requestAnimationFrame(() => {
    pageFrameAt = performance.now();
    watchPageFrames();
  });
}
watchPageFrames();

/** Frames between searches for a note not found yet. */
const SEARCH_EVERY = 30;

/** The renderers whose draws are timed already. */
const timed = new WeakSet<THREE.WebGLRenderer>();

/**
 * Time every frame callback of `session` and every draw of `renderer`,
 * from here on. Called as each session starts; three asks the session for
 * each frame by name, so the session's own method is the one to wrap. The
 * renderer outlives its sessions and is wrapped once.
 */
export function timeFrames(session: XRSession, renderer: THREE.WebGLRenderer): void {
  const request = session.requestAnimationFrame.bind(session);
  session.requestAnimationFrame = (callback) =>
    request((time, frame) => {
      const start = performance.now();
      try {
        callback(time, frame);
      } finally {
        spent.frame += performance.now() - start;
      }
    });
  if (timed.has(renderer)) {
    return;
  }
  timed.add(renderer);
  const render = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    const start = performance.now();
    try {
      render(scene, camera);
    } finally {
      spent.render += performance.now() - start;
    }
  };
}

/** What a trace follows. */
export interface TraceSubject {
  /** The notes, by their elements. */
  notes: readonly HTMLElement[];
  /** The angle each note is tilted by, in degrees, which no two share. */
  tilts: readonly number[];
  /** The object the notes' objects are under, once it is in the scene. */
  board: () => THREE.Object3D | null;
  /** The panels whose `data-xr-busy` each row reads, by name. */
  panels: readonly { name: string; element: HTMLElement }[];
  /** Whether to read the notes' computed styles and animations as well. */
  pageReads: boolean;
}

/**
 * A sampler for one run of a scene, called each frame with the ms since
 * the run's first. A scene with no notes gets the frame's times and its
 * busy panels alone.
 */
export function noteTracer({
  notes,
  tilts,
  board,
  panels,
  pageReads,
}: TraceSubject): (t: number) => TraceRow {
  let objects: (THREE.Object3D | null)[] = [];
  /** Each object's z off its parent when it was found, before any rise. */
  let rest: number[] = [];
  const moving = new Set<number>();
  let sinceSearch = SEARCH_EVERY;
  return (t) => {
    const start = performance.now();
    const root = board();
    // A note not found yet is looked for again every so often: the board
    // may still be mounting, and a note no tilt finds never will be.
    sinceSearch += 1;
    const lost = objects.some((object) => object && root && !isUnder(object, root));
    const missing = objects.length < tilts.length || objects.some((object) => !object);
    if (root && (lost || (missing && sinceSearch >= SEARCH_EVERY))) {
      sinceSearch = 0;
      // A note found already keeps its object and where it rested. Once
      // the board has lost one, every note is found afresh and rests
      // where it stands then.
      const found = findNotes(root, tilts);
      const kept = lost ? [] : objects;
      const keptRest = lost ? [] : rest;
      objects = found.map((object, n) => kept[n] ?? object);
      rest = objects.map((object, n) => (kept[n] ? keptRest[n] : object ? sceneZ(object) : 0));
    }
    const rows: NoteRow[] = [];
    notes.forEach((note, i) => {
      const animations = pageReads
        ? note.getAnimations({ subtree: true }).map((animation) => ({
            playState: animation.playState,
            anchored: typeof animation.startTime === "number",
            currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
          }))
        : null;
      const pageLift = pageReads ? liftOf(note) : null;
      const object = objects[i] ?? null;
      const sceneLift = object ? sceneZ(object) - rest[i] : null;
      // A note that settles is written once more, at rest, and then left.
      const active =
        (animations?.length ?? 0) > 0 ||
        Math.abs(pageLift ?? 0) > 0.01 ||
        Math.abs(sceneLift ?? 0) > 0.01;
      if (active || moving.has(i)) {
        rows.push({ i, pageLift: round(pageLift), sceneLift: round(sceneLift), animations });
      }
      if (active) {
        moving.add(i);
      } else {
        moving.delete(i);
      }
    });
    const row: TraceRow = {
      t: round(t),
      frameMs: round(spent.frame),
      renderMs: round(spent.render),
      traceMs: 0,
      pageFrameAgeMs: round(performance.now() - pageFrameAt),
      hovered: notes.findIndex((note) => note.hasAttribute("data-xr-hover")),
      busy: panels
        .filter(({ element }) => element.hasAttribute("data-xr-busy"))
        .map(({ name }) => name),
      notes: rows,
    };
    spent.frame = 0;
    spent.render = 0;
    row.traceMs = round(performance.now() - start);
    return row;
  };
}

/** A transform's z translation, in px, from the note's computed style. */
function liftOf(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  if (!transform.startsWith("matrix3d(")) {
    return 0;
  }
  return Number(transform.slice(9, -1).split(",")[14]);
}

/**
 * How far `object` stands off its parent, in px: the z its own matrix
 * moves it by, which is where freedom writes an element's CSS transform.
 * A portal turns its content half a turn about x, which turns z round, so
 * the sign is put back for a note that rises towards the viewer to count
 * up, as on the page.
 */
function sceneZ(object: THREE.Object3D): number {
  return -object.matrix.elements[14];
}

/**
 * Each note's object under `board`, by the angle its own matrix turns it
 * by about z: the notes are tilted by angles none of them shares. The
 * portal's half turn about x mirrors an angle about z, so either sign is
 * taken, the one that finds every note.
 */
function findNotes(board: THREE.Object3D, tilts: readonly number[]): (THREE.Object3D | null)[] {
  const candidates: { object: THREE.Object3D; angle: number }[] = [];
  board.traverse((object) => {
    const e = object.matrix.elements;
    const angle = (Math.atan2(e[1], e[0]) * 180) / Math.PI;
    if (Math.abs(angle) > 0.5) {
      candidates.push({ object, angle });
    }
  });
  const match = (sign: number) =>
    tilts.map(
      (tilt) =>
        candidates.find(({ angle }) => Math.abs(angle - sign * tilt) < 0.25)?.object ?? null,
    );
  const found = [match(1), match(-1)];
  return found[0].filter(Boolean).length >= found[1].filter(Boolean).length ? found[0] : found[1];
}

function isUnder(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let at: THREE.Object3D | null = object; at; at = at.parent) {
    if (at === root) {
      return true;
    }
  }
  return false;
}

function round<T extends number | null>(value: T): T {
  return (value === null ? null : Math.round(value * 100) / 100) as T;
}
