import * as THREE from "three";
import { render, createXRButton, children, cursors, $, dom, getScene } from "justdom-three";
import { inputModels } from "justdom-xr/scene";
import { canPresent } from "justdom-xr/session";
import { effects, effectsOnly, Stream, useEffects } from "justdom-signal";
import { captureEyes, countLinks, record, type EyeImage, type Run } from "./recorder.js";
import { PROBE_CSS, SCENES, type Place, type ProbePanel } from "./scenes.js";
import { noteTracer, timeFrames } from "./trace.js";

/**
 * The paint-order probe, `paint-order-probe.html`: the scenes of phase 4's
 * Quest half in `docs/freedom-paint-order-plan.md`, a control panel to work
 * them from inside the session, and the results, saved to disk by the dev
 * server (`vite/probeResults.js`). `?scene=` picks the scene, `?trace=scene`
 * keeps a run's trace off the page's styles (`trace.ts`), and `?emulator`
 * runs it under IWER on a desktop.
 */

const query = new URLSearchParams(location.search);
const sceneName = query.get("scene") ?? "pile";
const makeScene = SCENES[sceneName];
if (!makeScene) {
  throw new Error(`no scene called ${sceneName}; the scenes are ${Object.keys(SCENES).join(", ")}`);
}
const scene = makeScene();

/** How long an action's frames are recorded for. */
const ACTION_MS = 2500;
/**
 * How long Record records for: time enough to move the ray over a few
 * cards in turn.
 */
const RECORD_MS = 5000;

countLinks();
const style = document.createElement("style");
style.textContent = PROBE_CSS + (scene.style ?? "");
document.head.append(style);
if (scene.fonts) {
  const fonts = document.createElement("link");
  fonts.rel = "stylesheet";
  fonts.href = scene.fonts;
  document.head.append(fonts);
}

/** What the probe has found since the page loaded. */
const results: { runs: Run[]; eyes: EyeImage[][] } = { runs: [], eyes: [] };

const stage = find("[data-stage]");
const status = find("[data-status]");
find("[data-what]").textContent = `${scene.name}: ${scene.what}`;
// A portal draws what is inside its root and not the root's own box, so
// each panel's box, its opaque or translucent backdrop, goes in a root of
// its own.
const wrapped = scene.panels.map((panel) => {
  const root = document.createElement("div");
  root.append(panel.element);
  stage.append(root);
  return { panel, root };
});

/** The control panel, on the page and mirrored into the session. */
const controls = find("[data-controls]");
const controlsRoot = find("[data-controls-root]");
const actionButton = button("action", scene.action?.label);
const loopButton = button("loop", scene.loop?.label);
const recordButton = button("record", `Record ${RECORD_MS / 1000} s`);
const captureButton = button("capture", "Capture eyes");
const saveButton = button("save", "Save JSON");

/** Each panel marked `later`'s mount, called by `mountLater`. */
const laterMounts: (() => void)[] = [];
let mountedLater = false;

/** Mount every panel marked `later`. */
function mountLater(): void {
  mountedLater = true;
  laterMounts.forEach((mount) => mount());
}

let renderer: THREE.WebGLRenderer | null = null;
/** The first panel's object, which a trace finds the scene's notes under. */
let firstPanel: THREE.Object3D | null = null;
/** Which run's frames are being recorded, from the press on, if any. */
let recording: string | null = null;

actionButton.addEventListener("click", () => {
  const action = scene.action;
  if (!action) {
    return;
  }
  const session = readyToRecord();
  if (!session) {
    return;
  }
  // A panel mounts once; a second mount would measure nothing new.
  if (mountedLater) {
    say("The panel is mounted already. Reload the page to mount it again.");
    return;
  }
  recordRun(session, action.label, ACTION_MS, () => action.run(mountLater), "…");
});

recordButton.addEventListener("click", () => {
  const session = readyToRecord();
  if (!session) {
    return;
  }
  recordRun(
    session,
    `${RECORD_MS / 1000} s of frames`,
    RECORD_MS,
    () => {},
    ": move the ray over the scene now.",
  );
});

/**
 * The session a run can record, or none, said on the status line. One run
 * at a time: two would count the same frames twice and race for the status
 * line and the results, so a press while one records is refused.
 */
function readyToRecord(): XRSession | null {
  const session = renderer?.xr.getSession();
  if (!session) {
    say("Enter the session first.");
    return null;
  }
  if (recording) {
    say(`Still recording ${recording}. Wait for it to finish.`);
    return null;
  }
  return session;
}

/**
 * Record `session`'s frames for `ms`, calling `act` in the first, and say
 * what they came to. Called once `readyToRecord` has said a run can start.
 */
function recordRun(
  session: XRSession,
  label: string,
  ms: number,
  act: () => void,
  prompt: string,
): void {
  recording = label;
  say(`Recording ${label}${prompt}`);
  const sample = noteTracer({
    notes: scene.notes?.elements ?? [],
    tilts: scene.notes?.tilts ?? [],
    board: () => firstPanel,
    panels: [
      ...wrapped.map(({ root }, i) => ({ name: `panel ${i + 1}`, element: root })),
      { name: "controls", element: controlsRoot },
    ],
    pageReads: query.get("trace") !== "scene",
  });
  attempt(label, async () => {
    try {
      const run = await record(session, label, ms, act, sample);
      results.runs.push(run);
      say(
        `${run.action}: ${run.frames} frames, mean ${run.meanMs.toFixed(1)} ms, max` +
          ` ${run.maxMs.toFixed(1)} ms, ${run.overBudget} over the ${run.budgetMs.toFixed(1)} ms` +
          ` budget, ${run.programsLinked} programs linked.`,
      );
    } finally {
      recording = null;
    }
  });
}

loopButton.addEventListener("click", () => {
  scene.loop?.run();
  say(`${scene.loop?.label}: pressed. Press again to stop.`);
});

captureButton.addEventListener("click", () => {
  const presenting = renderer;
  if (!presenting?.xr.getSession()) {
    say("Enter the session first.");
    return;
  }
  attempt("Capture", async () => {
    const eyes = await captureEyes(presenting);
    results.eyes.push(eyes);
    say(
      `Captured ${eyes.map(({ eye, width, height }) => `${eye} ${width}×${height}`).join(", ")}.`,
    );
  });
});

saveButton.addEventListener("click", () => {
  attempt("Save", async () => {
    // The route names the file by the report's own scene.
    const response = await fetch(`${import.meta.env.BASE_URL}api/probe-results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: report(),
    });
    const body = (await response.json()) as { file?: string; message?: string };
    say(response.ok ? `Saved to ${body.file}.` : `Save failed: ${body.message}`);
  });
});

/** The probe's findings, as the file the dev server saves. */
function report(): string {
  return JSON.stringify({
    probe: "paint-order",
    scene: scene.name,
    userAgent: navigator.userAgent,
    ...results,
  });
}

function say(message: string): void {
  status.textContent = message;
}

/**
 * Run a button's work, and say on the status line why it failed if it
 * does: in the headset the status line is the only place an error shows.
 */
function attempt(what: string, work: () => Promise<void>): void {
  work().catch((error: unknown) =>
    say(`${what} failed: ${error instanceof Error ? error.message : String(error)}`),
  );
}

function find(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`The page has no ${selector}`);
  }
  return element;
}

/** A button on the control panel, or none for an action the scene lacks. */
function button(name: string, label: string | undefined): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.dataset.probe = name;
  element.textContent = label ?? "";
  element.hidden = !label;
  controls.append(element);
  return element;
}

/**
 * Stand a panel's object where `place` says, and hand it to `found`.
 */
function placed(place: Place, found: (object: THREE.Object3D) => void = () => {}) {
  return effects((object: THREE.Object3D) => {
    found(object);
    object.position.set(place.x, place.y, place.z);
    // Three turns a positive x rotation's top towards the viewer.
    object.rotation.set(-(place.rx ?? 0), place.ry ?? 0, 0);
    // A portal's object is 1 cm a px at a scale of 1.
    const scale = place.scale / 0.01;
    object.scale.set(scale, scale, scale);
  });
}

/** A panel of the scene, mounted now or by the Action button. */
function mounted(ctx: WeakKey, panel: ProbePanel, root: HTMLElement) {
  const found = (object: THREE.Object3D) => {
    if (panel === scene.panels[0]) {
      firstPanel = object;
    }
  };
  if (!panel.later) {
    return dom(ctx, root, [placed(panel.place, found)]);
  }
  const later = new Stream<HTMLElement>((subscriber) => {
    laterMounts.push(() => subscriber.next(root));
  });
  return dom(ctx, later, [placed(panel.place, found)]);
}

const probeScene = effectsOnly((ctx: WeakKey) => {
  useEffects(getScene(ctx), [
    children(
      ...wrapped.map(({ panel, root }) => mounted(ctx, panel, root)),
      // The control panel, low and to the left, turned towards the head.
      dom(ctx, controlsRoot, [
        placed({ x: -0.42, y: -0.3, z: -0.55, ry: 0.6, rx: 0.35, scale: 0.0006 }),
      ]),
      $(new THREE.AmbientLight(0xffffff, 2)),
      cursors(ctx, { color: "#ff3b30" }),
    ),
  ]);
});

async function start(): Promise<void> {
  if (query.has("emulator")) {
    const { install } = await import("justdom-xr/emulator");
    install({ devUI: query.get("emulator") !== "bare" });
  }
  if (!(await canPresent())) {
    say("This browser cannot present a session.");
    return;
  }
  render(probeScene, {
    ...inputModels(),
    presentingOnly: true,
  }).subscribe({
    next: (drawing) => {
      renderer = drawing;
      const canvas = drawing.domElement;
      canvas.style.cssText = "position: fixed; inset: 0; display: none; z-index: 60";
      document.body.append(canvas);
      drawing.xr.addEventListener("sessionstart", () => {
        canvas.style.display = "block";
        const session = drawing.xr.getSession();
        if (session) {
          timeFrames(session, drawing);
        }
      });
      drawing.xr.addEventListener("sessionend", () => {
        canvas.style.display = "none";
      });
      createXRButton(drawing, { ar: {}, vr: {} }).then((enter) => document.body.append(enter));
    },
  });
}

void start();
