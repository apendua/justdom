import * as THREE from "three";

/**
 * A WebGL2 context that draws nothing and counts what three asks of it, for
 * running three's own `WebGLRenderer` under a test runner that has no GPU.
 *
 * The point is three's bookkeeping, not pixels. Its program cache, its
 * material properties and its render lists all run as they do in a browser,
 * so a test can ask what a frame links, frees and draws. Everything three
 * reads back is answered as a context with nothing wrong would answer it:
 * every shader compiles, every program links with no active uniforms or
 * attributes, and no extension is there. Constants are numbers made up the
 * first time they are read, which is all three does with them besides
 * handing them back.
 *
 * `restoreContext` loses the context and gives it back, as a browser does
 * when the GPU is reset, so three builds its program cache again.
 *
 * @returns {{
 *   renderer: THREE.WebGLRenderer,
 *   restoreContext: () => void,
 *   counts: {
 *     programs: number,
 *     programsFreed: number,
 *     draws: number,
 *     unseenDraws: number,
 *   },
 * }}
 */
export function stubGlRenderer() {
  // `unseenDraws` are the draws made with every colour channel masked off.
  const counts = { programs: 0, programsFreed: 0, draws: 0, unseenDraws: 0 };
  let colourMasked = false;
  /** @type {Map<string, number>} */
  const constants = new Map();
  /** @type {Map<number, string>} */
  const names = new Map();
  const draw = () => {
    counts.draws += 1;
    if (colourMasked) {
      counts.unseenDraws += 1;
    }
  };
  /** @type {Record<string, unknown>} */
  const known = {
    getContextAttributes: () => ({
      alpha: true,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
    }),
    getExtension: () => null,
    getSupportedExtensions: () => [],
    getParameter: (/** @type {number} */ value) => {
      const name = names.get(value);
      if (name === "VERSION") {
        return "WebGL 2.0";
      }
      if (name === "SHADING_LANGUAGE_VERSION") {
        return "WebGL GLSL ES 3.00";
      }
      if (name === "VIEWPORT" || name === "SCISSOR_BOX") {
        return new Int32Array([0, 0, 1, 1]);
      }
      // Every limit three asks about, and enough for any of them.
      return 16;
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getShaderParameter: () => true,
    getProgramParameter: (/** @type {unknown} */ _program, /** @type {number} */ value) =>
      names.get(value)?.startsWith("ACTIVE_") ? 0 : true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getError: () => 0,
    isContextLost: () => false,
    getUniformLocation: () => null,
    getAttribLocation: () => -1,
    createProgram: () => {
      counts.programs += 1;
      return {};
    },
    deleteProgram: () => {
      counts.programsFreed += 1;
    },
    colorMask: (/** @type {boolean[]} */ ...channels) => {
      colourMasked = channels.every((channel) => !channel);
    },
    drawArrays: draw,
    drawElements: draw,
    drawArraysInstanced: draw,
    drawElementsInstanced: draw,
  };
  /** @type {Map<string, (event: { preventDefault(): void }) => void>} */
  const listeners = new Map();
  const canvas = {
    width: 1,
    height: 1,
    style: {},
    /**
     * @param {string} type
     * @param {(event: { preventDefault(): void }) => void} listener
     */
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener() {},
  };
  const restoreContext = () => {
    const event = { preventDefault() {} };
    listeners.get("webglcontextlost")?.(event);
    listeners.get("webglcontextrestored")?.(event);
  };
  const gl = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string") {
          return undefined;
        }
        if (name in known) {
          return known[name];
        }
        if (name === "canvas") {
          return canvas;
        }
        if (/^[A-Z0-9_]+$/.test(name)) {
          let value = constants.get(name);
          if (value === undefined) {
            value = 0x10000 + constants.size;
            constants.set(name, value);
            names.set(value, name);
          }
          return value;
        }
        // `createBuffer`, `createTexture` and the like: a handle three only
        // hands back. Everything else is a call with nothing to say.
        return name.startsWith("create") ? () => ({}) : () => {};
      },
    },
  );
  const renderer = new THREE.WebGLRenderer({
    context: /** @type {WebGL2RenderingContext} */ (gl),
    canvas: /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (canvas)),
  });
  return { renderer, counts, restoreContext };
}
