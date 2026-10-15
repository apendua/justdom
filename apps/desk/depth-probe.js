// Temporary, for item 10.2 of docs/freedom-architecture-plan.md; see
// depth-probe.html for how to run it. Not part of the desk. Item 10.1's
// probe (#576) with the pile drawn by freedom's own depth bias.
import * as THREE from "three";
// By path rather than by package: the bias is a prototype and not among
// freedom's exports. The probe compiles the GLSL the box batch compiles.
import {
  DEPTH_RANK_EPSILON,
  DEPTH_RANK_FLOOR,
  DEPTH_RANK_GLSL,
  DEPTH_RANK_SLOPE_FACTOR,
  depthRankDefines,
  readDepthRankViewport,
} from "../../packages/freedom/src/elements/boxBatch.js";

const query = new URLSearchParams(location.search);
if (query.has("emulator")) {
  const { install } = await import("@apendua.dev/headset/emulator");
  install({ devUI: false });
}

const out = /** @type {HTMLElement} */ (document.getElementById("out"));
/** Everything measured so far, for Copy JSON. */
const results = { session: null, targets: null, sweep: [], summary: [], windows: [] };

function show(text) {
  out.textContent = text;
}
function append(line) {
  out.textContent += `\n${line}`;
  console.log(line);
}

// The renderer and camera as freedom's render() makes them (render.js).
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
const SIZE = Number(query.get("size")) || 512;
renderer.setSize(SIZE, SIZE);
document.body.appendChild(renderer.domElement);
const NEAR = 0.1;
const FAR = 20;
const camera = new THREE.PerspectiveCamera(70, 1, NEAR, FAR);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local");
const gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());

function glRendererName() {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}

/** Depth bits and type of whatever framebuffer is bound now. */
function boundDepth() {
  const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  if (bound === null) {
    return { framebuffer: "default", bits: gl.getParameter(gl.DEPTH_BITS) };
  }
  const attachment = (name) => {
    try {
      return gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, name);
    } catch (error) {
      return String(error);
    }
  };
  const type = attachment(gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE);
  return {
    framebuffer: "own",
    bits: attachment(gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE),
    type: type === gl.FLOAT ? "float" : type === gl.UNSIGNED_NORMALIZED ? "unorm" : type,
  };
}

function depthOfTarget(target) {
  renderer.setRenderTarget(target);
  const depth = boundDepth();
  renderer.setRenderTarget(null);
  return depth;
}

// ---------------------------------------------------------------------------
// The pile: rank 0 is the board, 1..200 the cards, each a staircase step
// off the last, so every adjacent pair shares pixels and differs in vertices.

/** A panel px in metres, unless a pose says otherwise. */
const PX = 0.001;
const CARDS = 200;

// freedom's chunk, with its constants read from uniforms so a sweep can
// vary them: the defines name the uniforms in place of numbers.
const vertexShader = /* glsl */ `
  uniform float uEps;
  uniform float uK;
  attribute float aDepthRank;
  ${DEPTH_RANK_GLSL}
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z -= aDepthRank * depthRankStep(modelViewMatrix, gl_Position) * gl_Position.w;
  }
`;
// The analysis colour is the rank in red, exactly; the visual one tells
// neighbouring ranks apart for an eye.
const fragmentShader = /* glsl */ `
  uniform float uRank;
  uniform float uVisual;
  void main() {
    vec3 visual = vec3(fract(uRank * 0.618), fract(uRank * 0.382 + 0.3), 0.55);
    gl_FragColor = uVisual > 0.5 ? vec4(visual, 1.0) : vec4(uRank / 255.0, 0.0, 0.0, 1.0);
  }
`;

/** @typedef {"constant" | "slope"} Formula */

const shared = {
  uEps: { value: 0 },
  uK: { value: 0 },
  uVisual: { value: 0 },
  uDepthRankViewport: { value: new THREE.Vector2(SIZE, SIZE) },
};

/** @param {Formula} formula */
function definesFor(formula) {
  return {
    ...depthRankDefines(formula),
    DEPTH_RANK_EPSILON: "uEps",
    DEPTH_RANK_SLOPE_FACTOR: "uK",
  };
}

/** Each eye's viewport in a session, read as the box batch reads it. */
function followViewport(rendererArg) {
  readDepthRankViewport(rendererArg, shared.uDepthRankViewport.value);
}

const cards = [];
const pileGroup = new THREE.Group();
{
  for (let rank = 0; rank <= CARDS; rank++) {
    const geometry =
      rank === 0
        ? new THREE.PlaneGeometry(700 * PX, 600 * PX)
        : new THREE.PlaneGeometry(240 * PX, 160 * PX);
    geometry.setAttribute(
      "aDepthRank",
      new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count).fill(rank), 1),
    );
    const material = new THREE.ShaderMaterial({
      defines: definesFor("constant"),
      vertexShader,
      fragmentShader,
      uniforms: { ...shared, uRank: { value: rank } },
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    if (rank > 0) {
      const i = rank - 1;
      mesh.position.set((-150 + i * 1.5) * PX, (-110 + i * 1.1) * PX, 0);
    }
    mesh.onBeforeRender = followViewport;
    cards.push(mesh);
    pileGroup.add(mesh);
  }
}
const pileScene = new THREE.Scene();
pileScene.add(pileGroup);

/** @param {Formula} formula */
function useFormula(formula) {
  for (const mesh of cards) {
    mesh.material.defines = definesFor(formula);
    mesh.material.needsUpdate = true;
  }
}

/**
 * @param {"reference" | "ascending" | "descending"} mode The reference is
 *   painter's order with no depth test; the other two test depth, bottom
 *   card first or top card first.
 */
function setOrder(mode) {
  for (const [rank, mesh] of cards.entries()) {
    mesh.material.depthTest = mode !== "reference";
    mesh.material.depthWrite = mode !== "reference";
    // three sorts opaque objects by renderOrder before distance.
    mesh.renderOrder = mode === "descending" ? -rank : rank;
  }
}

/**
 * @param {number} distance
 * @param {number} tilt Degrees about x, tipping the pile's top away.
 * @param {number} yaw Degrees about y.
 * @param {number} [px] The pile's px in metres, against `PX`.
 */
function placePile(distance, tilt, yaw, px = PX) {
  pileGroup.position.set(0, 0, -distance);
  pileGroup.rotation.set((-tilt * Math.PI) / 180, (yaw * Math.PI) / 180, 0, "YXZ");
  pileGroup.scale.setScalar(px / PX);
  pileGroup.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// 1. The session, and the pile in it.

/** What the trigger steps through: the two formulas at freedom's numbers. */
const VISUAL = [
  { formula: "slope", eps: DEPTH_RANK_EPSILON, k: DEPTH_RANK_SLOPE_FACTOR },
  { formula: "constant", eps: DEPTH_RANK_EPSILON, k: 0 },
  { formula: "constant", eps: 0, k: 0 },
];

/**
 * A label above the pile saying which bias it is drawn with. It is in the
 * pile's scene only during a session, so the sweep never draws it.
 */
const labelCanvas = document.createElement("canvas");
labelCanvas.width = 512;
labelCanvas.height = 128;
const labelTexture = new THREE.CanvasTexture(labelCanvas);
labelTexture.colorSpace = THREE.SRGBColorSpace;
const label = new THREE.Mesh(
  new THREE.PlaneGeometry(0.4, 0.1),
  new THREE.MeshBasicMaterial({ map: labelTexture }),
);
label.position.set(0, 0.32, -1);

const fmt = (value) => (value === 0 ? "0" : `2^${Math.log2(value)}`);

function useVisual({ formula, eps, k }) {
  useFormula(formula);
  shared.uEps.value = eps;
  shared.uK.value = k;
  const context = /** @type {CanvasRenderingContext2D} */ (labelCanvas.getContext("2d"));
  context.fillStyle = "#222";
  context.fillRect(0, 0, labelCanvas.width, labelCanvas.height);
  context.fillStyle = "#fff";
  context.font = "bold 48px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const text =
    formula === "slope" ? `slope, k = ${fmt(k)}` : eps === 0 ? "ε = 0" : `ε = ${fmt(eps)}`;
  context.fillText(text, labelCanvas.width / 2, labelCanvas.height / 2);
  labelTexture.needsUpdate = true;
}

document.getElementById("start").addEventListener("click", async () => {
  try {
    if (!navigator.xr) throw new Error("no navigator.xr");
    const session = await navigator.xr.requestSession("immersive-vr", {
      optionalFeatures: ["local-floor"],
    });
    show("In the session.");
    await renderer.xr.setSession(session);
    placePile(1, 75, 15);
    shared.uVisual.value = 1;
    setOrder("descending");
    let visualIndex = 0;
    useVisual(VISUAL[visualIndex]);
    pileScene.add(label);
    const shown = [];
    session.addEventListener("select", () => {
      visualIndex = (visualIndex + 1) % VISUAL.length;
      useVisual(VISUAL[visualIndex]);
      shown.push(VISUAL[visualIndex]);
    });
    let count = 0;
    const errors = {};
    renderer.setAnimationLoop(() => {
      try {
        renderer.render(pileScene, camera);
      } catch (error) {
        errors.render ??= `${error}\n${error?.stack ?? ""}`;
      }
      ++count;
    });
    session.addEventListener("end", () => {
      renderer.setAnimationLoop(null);
      shared.uVisual.value = 0;
      shared.uDepthRankViewport.value.set(SIZE, SIZE);
      pileScene.remove(label);
      results.session = { glRenderer: glRendererName(), frames: count, errors, shown };
      show(`Session:\n${JSON.stringify(results.session, null, 2)}`);
    });
  } catch (error) {
    show(`Session failed: ${error}`);
  }
});

// ---------------------------------------------------------------------------
// 2. The sweep, off screen.

function makeTarget(kind) {
  if (kind === "msaa") {
    return new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 4 });
  }
  // What a WebGLRenderTarget gets by default: DEPTH_COMPONENT24, which is
  // what the ghost's snapshot and three's projection layer both ask for.
  return new THREE.WebGLRenderTarget(SIZE, SIZE);
}

const targets = {};
function target(kind) {
  return (targets[kind] ??= makeTarget(kind));
}

const buffer = new Uint8Array(SIZE * SIZE * 4);
const reference = new Uint8Array(SIZE * SIZE * 4);

function draw(kind, cam, into) {
  const rt = target(kind);
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(pileScene, cam);
  renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, into);
  renderer.setRenderTarget(null);
}

function cameraFor(kind) {
  if (kind === "ortho") {
    // The ghost's camera (ghostSnapshot.js cameraFor): framed on the box,
    // DEPTH = 500 px in front of it, far plane at 2 * DEPTH, near at 0.
    const half = 360 * PX;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0, 1000 * PX);
    cam.position.set(0, 0, 500 * PX);
    cam.updateMatrixWorld(true);
    return cam;
  }
  const cam = new THREE.PerspectiveCamera(70, 1, NEAR, FAR);
  cam.updateMatrixWorld(true);
  return cam;
}

function placeFor(config) {
  if (config.camera === "ortho") {
    placePile(0, 0, 0);
  } else {
    placePile(config.distance, config.tilt, config.yaw, config.px);
  }
}

/**
 * Pixels that differ from the reference, top card first plus bottom card
 * first, for one pile and one bias.
 */
function pileTest(config, { eps, k }) {
  renderer.xr.enabled = false;
  placeFor(config);
  const cam = cameraFor(config.camera);
  shared.uEps.value = eps;
  shared.uK.value = k;
  setOrder("reference");
  draw(config.target, cam, reference);
  let covered = 0;
  for (let i = 3; i < reference.length; i += 4) {
    if (reference[i] !== 0) covered++;
  }
  let wrong = 0;
  for (const order of ["descending", "ascending"]) {
    setOrder(order);
    draw(config.target, cam, buffer);
    for (let i = 0; i < reference.length; i += 4) {
      if (
        reference[i + 3] !== 0 &&
        (reference[i] !== buffer[i] || reference[i + 3] !== buffer[i + 3])
      ) {
        wrong++;
      }
    }
  }
  renderer.xr.enabled = true;
  return { covered, wrong };
}

/**
 * The pile's depth slope, the change in NDC depth from one pixel to the
 * next, worked out on the CPU from where the camera's rays meet the pile's
 * plane, a different route from the shader's: at the centre pixel, one
 * pixel to the right and one up.
 */
function slopeOf(config) {
  placeFor(config);
  const cam = cameraFor(config.camera);
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(pileGroup.matrixWorld);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    normal,
    new THREE.Vector3().setFromMatrixPosition(pileGroup.matrixWorld),
  );
  const ray = new THREE.Raycaster();
  const depthAt = (x, y) => {
    ray.setFromCamera(new THREE.Vector2(x, y), cam);
    const point = ray.ray.intersectPlane(plane, new THREE.Vector3());
    return point ? point.project(cam).z : NaN;
  };
  const centre = new THREE.Vector3().setFromMatrixPosition(pileGroup.matrixWorld).project(cam);
  const step = 2 / SIZE;
  const z = depthAt(centre.x, centre.y);
  return Math.max(
    Math.abs(depthAt(centre.x + step, centre.y) - z),
    Math.abs(depthAt(centre.x, centre.y + step) - z),
  );
}

/** How deep a window of `ranks` at `step` NDC a rank is at `distance` m. */
function windowDepth(ranks, step, distance) {
  return (ranks * step * (FAR - NEAR) * distance * distance) / (2 * FAR * NEAR);
}

const EPS = [2 ** -24, 2 ** -22, 2 ** -20, 2 ** -18, 2 ** -16, 2 ** -14, 2 ** -12];
const K = [2 ** -8, 2 ** -6, 2 ** -4, 2 ** -3, 2 ** -2, 2 ** -1, 1, 2, 4];
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** The desk's panels, as the eye sees them when it looks straight at one. */
const DESK_POSES = [
  { name: "desk board", distance: 0.87, tilt: 11, yaw: 0, px: 0.00095 },
  { name: "desk keyboard", distance: 0.62, tilt: 50, yaw: 0, px: 0.00065 },
  { name: "desk memo", distance: 0.71, tilt: 54, yaw: 6, px: 0.00065 },
];

function configs() {
  const list = [];
  for (const kind of ["rt", "msaa"]) {
    for (const [yaw, tilt] of [
      [0, 0],
      [15, 0],
      [15, 45],
      [15, 75],
    ]) {
      for (const distance of [1, 5, 10]) {
        list.push({
          name: `${kind} ${distance} m yaw ${yaw} tilt ${tilt}`,
          target: kind,
          camera: "persp",
          distance,
          tilt,
          yaw,
        });
      }
    }
    for (const pose of DESK_POSES) {
      list.push({ ...pose, name: `${kind} ${pose.name}`, target: kind, camera: "persp" });
    }
  }
  list.push({ name: "rt ghost", target: "rt", camera: "ortho", distance: 0, tilt: 0, yaw: 0 });
  return list;
}

/**
 * The least value of `values` that leaves no pixel of the pile wrong.
 *
 * @param {Formula} formula
 */
async function least(config, formula, values) {
  const cells = [];
  let found = null;
  for (const value of values) {
    const bias = formula === "slope" ? { eps: 0, k: value } : { eps: value, k: 0 };
    const result = pileTest(config, bias);
    results.sweep.push({ ...config, formula, value, ...result });
    cells.push(`${fmt(value)}:${result.wrong}`);
    await nextFrame();
    if (result.wrong === 0) {
      found = value;
      break;
    }
  }
  return { found, cells };
}

document.getElementById("sweep").addEventListener("click", async () => {
  if (renderer.xr.isPresenting) return;
  results.gpu = glRendererName();
  results.size = SIZE;
  results.targets = {
    rt: depthOfTarget(target("rt")),
    msaa: depthOfTarget(target("msaa")),
  };
  results.sweep = [];
  results.summary = [];
  results.windows = [];
  show(
    `GPU: ${glRendererName()}\nTargets: ${JSON.stringify(results.targets)}\n` +
      `Least clean value per pile, ${SIZE} px: ε for the constant, k for the slope ` +
      `with a floor of ${fmt(DEPTH_RANK_FLOOR)}; each cell is wrong pixels:`,
  );
  for (const config of configs()) {
    useFormula("constant");
    const constant = await least(config, "constant", EPS);
    useFormula("slope");
    const slope = await least(config, "slope", K);
    const perPixel = slopeOf(config);
    const row = {
      name: config.name,
      slope: perPixel,
      epsilon: constant.found === null ? "none" : fmt(constant.found),
      k: slope.found === null ? "none" : fmt(slope.found),
    };
    results.summary.push(row);
    append(
      `${config.name}: slope ${perPixel.toExponential(2)} ε ${row.epsilon} k ${row.k}` +
        `   ${constant.cells.join(" ")} | ${slope.cells.join(" ")}`,
    );
  }
  // What 200 ranks take up under freedom's two numbers, for each pile the
  // perspective camera sees.
  append("\n200 ranks, in mm: constant at freedom's ε, slope at freedom's k");
  for (const config of configs()) {
    if (config.target !== "rt" || config.camera !== "persp") continue;
    const perPixel = slopeOf(config);
    const slopeStep = DEPTH_RANK_SLOPE_FACTOR * perPixel + DEPTH_RANK_FLOOR;
    const row = {
      name: config.name,
      constant: windowDepth(CARDS, DEPTH_RANK_EPSILON, config.distance) * 1000,
      slope: windowDepth(CARDS, slopeStep, config.distance) * 1000,
    };
    results.windows.push(row);
    append(`${row.name}: ${row.constant.toFixed(2)} | ${row.slope.toFixed(2)}`);
  }
  append("Done.");
});

document.getElementById("copy").addEventListener("click", async () => {
  const text = JSON.stringify(results, null, 2);
  console.log(text);
  try {
    await navigator.clipboard.writeText(text);
    append("Copied.");
  } catch {
    show(text);
  }
});

/** For a script driving the page. */
window.probe = { results, pileTest, slopeOf, useFormula, configs };
window.endSession = () => renderer.xr.getSession()?.end();

for (const button of document.querySelectorAll("button")) {
  button.disabled = false;
}
