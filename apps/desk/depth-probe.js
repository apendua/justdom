// Temporary, for item 10.1 of docs/freedom-architecture-plan.md (#576); see
// depth-probe.html for how to run it. Not part of the desk.
import * as THREE from "three";

const query = new URLSearchParams(location.search);
if (query.has("emulator")) {
  const { install } = await import("@apendua.dev/headset/emulator");
  install({ devUI: false });
}

const out = /** @type {HTMLElement} */ (document.getElementById("out"));
/** Everything measured so far, for Copy JSON. */
const results = { session: null, targets: null, sweep: [], summary: [] };

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
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 20);
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

/** n and f back out of a GL perspective matrix (column-major). */
function planesOf(m) {
  return {
    m10: m[10],
    m14: m[14],
    near: m[14] / (m[10] - 1),
    far: m[10] === -1 ? Infinity : m[14] / (m[10] + 1),
    reversed: m[10] > 0,
  };
}

// ---------------------------------------------------------------------------
// The pile: rank 0 is the board, 1..200 the cards, each a staircase step
// off the last, so every adjacent pair shares pixels and differs in vertices.

/** A panel px in metres; the apps' panels are about this. */
const PX = 0.001;
const CARDS = 200;

const vertexShader = /* glsl */ `
  uniform float uRank;
  uniform float uEps;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z -= uRank * uEps * gl_Position.w;
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

const epsUniform = { value: 0 };
const visualUniform = { value: 0 };
const cards = [];
const pileGroup = new THREE.Group();
{
  const board = new THREE.PlaneGeometry(700 * PX, 600 * PX);
  const card = new THREE.PlaneGeometry(240 * PX, 160 * PX);
  for (let rank = 0; rank <= CARDS; rank++) {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uRank: { value: rank }, uEps: epsUniform, uVisual: visualUniform },
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(rank === 0 ? board : card, material);
    if (rank > 0) {
      const i = rank - 1;
      mesh.position.set((-150 + i * 1.5) * PX, (-110 + i * 1.1) * PX, 0);
    }
    cards.push(mesh);
    pileGroup.add(mesh);
  }
}
const pileScene = new THREE.Scene();
pileScene.add(pileGroup);

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

function placePile(distance, tilt, yaw) {
  pileGroup.position.set(0, 0, -distance);
  pileGroup.rotation.set((-tilt * Math.PI) / 180, (yaw * Math.PI) / 180, 0, "YXZ");
  pileGroup.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// 1. The session, and the pile in it.

const VISUAL_EPS = [0, 2 ** -21, 2 ** -16, 2 ** -12];

/**
 * A label above the pile saying which epsilon it is drawn with. It is in
 * the pile's scene only during a session, so the sweep never draws it.
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

function showEpsilon(eps) {
  const context = /** @type {CanvasRenderingContext2D} */ (labelCanvas.getContext("2d"));
  context.fillStyle = "#222";
  context.fillRect(0, 0, labelCanvas.width, labelCanvas.height);
  context.fillStyle = "#fff";
  context.font = "bold 64px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const text = eps === 0 ? "\u03b5 = 0" : `\u03b5 = 2^${Math.log2(eps)}`;
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
    visualUniform.value = 1;
    setOrder("descending");
    let visualIndex = 1;
    epsUniform.value = VISUAL_EPS[visualIndex];
    showEpsilon(epsUniform.value);
    pileScene.add(label);
    const shown = [];
    session.addEventListener("select", () => {
      visualIndex = (visualIndex + 1) % VISUAL_EPS.length;
      epsUniform.value = VISUAL_EPS[visualIndex];
      showEpsilon(epsUniform.value);
      shown.push(epsUniform.value);
    });
    let count = 0;
    let read = false;
    /** What went wrong inside the session's frames, first of each kind. */
    const errors = {};
    const note = (where, error) => {
      errors[where] ??= `${error}\n${error?.stack ?? ""}`;
    };
    renderer.setAnimationLoop((_time, frame) => {
      try {
        renderer.render(pileScene, camera);
      } catch (error) {
        note("render", error);
      }
      ++count;
      // Read once the session has drawn a few frames, and only from a call
      // that carries an XRFrame: on the headset some do not. Retry until a
      // read gets through, keeping the first error.
      if (count < 5 || read || !frame) return;
      try {
        readSession(session, frame);
        read = true;
      } catch (error) {
        note("report", error);
      }
    });
    session.addEventListener("end", () => {
      renderer.setAnimationLoop(null);
      visualUniform.value = 0;
      pileScene.remove(label);
      results.session = {
        ...results.session,
        frames: count,
        read,
        errors,
        epsilonsShown: shown,
      };
      show(`Session:\n${JSON.stringify(results.session, null, 2)}`);
      console.log(JSON.stringify(results.session));
    });
  } catch (error) {
    show(`Session failed: ${error}`);
  }
});

/** What the session gets: its layer, its depth buffer and its planes. */
function readSession(session, frame) {
  results.session = { glRenderer: glRendererName() };
  // three binds the session's own target before this callback, so
  // what is bound after a render is what the headset draws into.
  const target = renderer.getRenderTarget();
  results.session.depth = boundDepth();
  const layer = renderer.xr.getBaseLayer();
  const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
  if (!pose) throw new Error("no viewer pose yet");
  results.session = {
    ...results.session,
    userAgent: navigator.userAgent,
    contextAttributes: gl.getContextAttributes(),
    projectionLayerApi:
      typeof XRWebGLBinding !== "undefined" && "createProjectionLayer" in XRWebGLBinding.prototype,
    layer: layer?.constructor?.name,
    layerSize: layer?.textureWidth
      ? [layer.textureWidth, layer.textureHeight]
      : [layer?.framebufferWidth, layer?.framebufferHeight],
    ignoreDepthValues: layer?.ignoreDepthValues,
    threeDepthTexture: target?.depthTexture
      ? { type: target.depthTexture.type, format: target.depthTexture.format }
      : null,
    samples: target?.samples,
    renderState: {
      depthNear: session.renderState.depthNear,
      depthFar: session.renderState.depthFar,
    },
    views: pose?.views.map((view) => ({ eye: view.eye, ...planesOf(view.projectionMatrix) })),
  };
}

// ---------------------------------------------------------------------------
// 2. The sweep, off screen.

function makeTarget(kind) {
  if (kind === "rt16") {
    return new THREE.WebGLRenderTarget(SIZE, SIZE, {
      depthTexture: new THREE.DepthTexture(SIZE, SIZE, THREE.UnsignedShortType),
    });
  }
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
  const cam = new THREE.PerspectiveCamera(70, 1, 0.1, 20);
  cam.updateMatrixWorld(true);
  return cam;
}

/**
 * Pixels that differ from the reference, top card first plus bottom card
 * first, for one pile and one epsilon.
 */
function pileTest({ target: kind, camera: camKind, distance, tilt, yaw, eps }) {
  renderer.xr.enabled = false;
  if (camKind === "ortho") {
    placePile(0, 0, 0);
  } else {
    placePile(distance, tilt, yaw);
  }
  const cam = cameraFor(camKind);
  epsUniform.value = eps;
  setOrder("reference");
  draw(kind, cam, reference);
  let covered = 0;
  for (let i = 3; i < reference.length; i += 4) {
    if (reference[i] !== 0) covered++;
  }
  let wrong = 0;
  for (const order of ["descending", "ascending"]) {
    setOrder(order);
    draw(kind, cam, buffer);
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
window.pileTest = pileTest;

const EPS = [0, 2 ** -24, 2 ** -22, 2 ** -20, 2 ** -18, 2 ** -16, 2 ** -14, 2 ** -12];
const fmt = (eps) => (eps === 0 ? "0" : `2^${Math.log2(eps)}`);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

document.getElementById("sweep").addEventListener("click", async () => {
  if (renderer.xr.isPresenting) return;
  results.gpu = glRendererName();
  results.size = SIZE;
  results.targets = {
    rt: depthOfTarget(target("rt")),
    rt16: depthOfTarget(target("rt16")),
    msaa: depthOfTarget(target("msaa")),
  };
  results.sweep = [];
  results.summary = [];
  show(
    `GPU: ${glRendererName()}\nTargets: ${JSON.stringify(results.targets)}\n` +
      `Least clean epsilon (NDC a rank), ${SIZE} px; each cell is wrong pixels:`,
  );
  const configs = [];
  for (const kind of ["rt", "msaa"]) {
    for (const [yaw, tilt] of [
      [0, 0],
      [15, 0],
      [15, 45],
      [15, 75],
    ]) {
      for (const distance of [1, 5, 10]) {
        configs.push({ target: kind, camera: "persp", distance, tilt, yaw });
      }
    }
  }
  configs.push({ target: "rt", camera: "ortho", distance: 0, tilt: 0, yaw: 0 });
  configs.push({ target: "rt16", camera: "ortho", distance: 0, tilt: 0, yaw: 0 });
  for (const config of configs) {
    const cells = [];
    let least = null;
    for (const eps of config.target === "rt16" ? [...EPS, 2 ** -10] : EPS) {
      const result = pileTest({ ...config, eps });
      results.sweep.push({ ...config, eps, ...result });
      cells.push(`${fmt(eps)}:${result.wrong}`);
      if (least === null && result.wrong === 0 && eps > 0) least = eps;
      await nextFrame();
    }
    const name =
      config.camera === "ortho"
        ? `${config.target} ghost`
        : `${config.target} ${config.distance} m yaw ${config.yaw} tilt ${config.tilt}`;
    results.summary.push({ name, least: least === null ? "none" : fmt(least) });
    append(`${name}: ${least === null ? "none" : fmt(least)}   ${cells.join(" ")}`);
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

/** For a script driving the page under the emulator. */
window.endSession = () => renderer.xr.getSession()?.end();

for (const button of document.querySelectorAll("button")) {
  button.disabled = false;
}
