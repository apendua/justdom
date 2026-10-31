import type * as THREE from "three";

/**
 * What the paint-order probe measures in a session: the interval between
 * the session's frames over an action, the programs linked meanwhile, a
 * row for each frame from the run's sampler, and each eye's image in one
 * frame.
 *
 * A frame is over the headset's budget when it comes later than one and a
 * half frames of the session's rate after the one before: the compositor
 * showed the frame before it twice.
 */

/** One action's frames. */
export interface Run {
  /** What was done. */
  action: string;
  /** The session's frame rate, as it reports it, or null if it does not. */
  frameRate: number | null;
  /** A frame's budget in ms: 1000 over the rate, or the median interval. */
  budgetMs: number;
  frames: number;
  meanMs: number;
  maxMs: number;
  /** Frames later than 1.5 budgets after the one before. */
  overBudget: number;
  /** `linkProgram` calls from the action's start to its end. */
  programsLinked: number;
  /** Every interval, in ms, for a look afterwards. */
  intervalsMs: number[];
  /** A row for each frame, from the run's sampler (`trace.ts`). */
  trace: unknown[];
}

/**
 * One eye's image, as a PNG data URL, or none for a view with no pixels:
 * the emulator draws its second eye in a viewport of no width.
 */
export interface EyeImage {
  eye: string;
  width: number;
  height: number;
  png: string | null;
}

let linked = 0;

/**
 * Count the page's `linkProgram` calls from here on. A program linked in an
 * action's frames is a compile the first use of something paid for.
 */
export function countLinks(): void {
  const proto = WebGL2RenderingContext.prototype;
  const link = proto.linkProgram;
  proto.linkProgram = function (program: WebGLProgram) {
    linked += 1;
    return link.call(this, program);
  };
}

/**
 * The time of `session`'s next frame, or a rejection if the session ends
 * first: an ended session calls no more frames.
 */
function nextFrame(session: XRSession): Promise<number> {
  return inFrame(session, (time) => time);
}

/**
 * Run `read` in the next frame of `session`, in the frame's own callback,
 * the one place its pose is valid. Rejects if `read` throws or the session
 * ends before the frame.
 */
function inFrame<T>(session: XRSession, read: (time: number, frame: XRFrame) => T): Promise<T> {
  return untilEnd(
    session,
    new Promise((done, fail) =>
      session.requestAnimationFrame((time, frame) => {
        try {
          done(read(time, frame));
        } catch (error) {
          fail(error);
        }
      }),
    ),
  );
}

/**
 * `promise`, or a rejection if `session` ends before it settles. Whatever
 * the probe waits on in a session goes through here, since an ended session
 * settles nothing it was asked for: it drops its frame callbacks.
 */
function untilEnd<T>(session: XRSession, promise: Promise<T>): Promise<T> {
  return new Promise((done, fail) => {
    const ended = () => fail(new Error("the session ended"));
    session.addEventListener("end", ended, { once: true });
    promise.then(done, fail).finally(() => session.removeEventListener("end", ended));
  });
}

/**
 * Record `session`'s frames for `ms` from now, calling `act` in the first
 * and `sample` in every one after it, with the ms since the first.
 * Rejects if the session ends first.
 */
export async function record(
  session: XRSession,
  action: string,
  ms: number,
  act: () => void,
  sample: (t: number) => unknown,
): Promise<Run> {
  const linkedBefore = linked;
  const times: number[] = [];
  const trace: unknown[] = [];
  const start = await nextFrame(session);
  times.push(start);
  act();
  for (;;) {
    const time = await inFrame(session, (time) => {
      trace.push(sample(time - start));
      return time;
    });
    times.push(time);
    if (time - start >= ms) {
      break;
    }
  }
  const intervalsMs = times.slice(1).map((time, i) => time - times[i]);
  const sorted = [...intervalsMs].sort((a, b) => a - b);
  const frameRate = session.frameRate ?? null;
  const budgetMs = frameRate ? 1000 / frameRate : sorted[Math.floor(sorted.length / 2)];
  return {
    action,
    frameRate,
    budgetMs,
    frames: intervalsMs.length,
    meanMs: intervalsMs.reduce((sum, interval) => sum + interval, 0) / intervalsMs.length,
    maxMs: sorted[sorted.length - 1],
    overBudget: intervalsMs.filter((interval) => interval > budgetMs * 1.5).length,
    programsLinked: linked - linkedBefore,
    intervalsMs,
    trace,
  };
}

/**
 * Both eyes' images of one frame, read back from the layer `renderer`
 * draws to.
 *
 * Read in a frame requested after the renderer has asked for its own, so
 * the renderer has drawn the frame before this reads it: the first request
 * here can come before the renderer's in its frame, the second cannot.
 *
 * Where the browser has WebXR layers, as the Quest's does, three draws to a
 * projection layer, which has no framebuffer of its own: each view's image
 * is in the colour texture its sub-image names, read through a framebuffer
 * made for the read. Otherwise it is in the `XRWebGLLayer`'s framebuffer.
 * Rejects if the session ends first.
 */
export async function captureEyes(renderer: THREE.WebGLRenderer): Promise<EyeImage[]> {
  const session = renderer.xr.getSession();
  if (!session) {
    throw new Error("there is no session to read");
  }
  // Asked for per capture: a space does not outlive its session.
  const space = await untilEnd(session, session.requestReferenceSpace("local"));
  await nextFrame(session);
  const images = await inFrame(session, (_, frame) => {
    const pose = frame.getViewerPose(space);
    if (!pose) {
      throw new Error("the frame has no pose to read");
    }
    return readViews(renderer, pose.views);
  });
  return images.map(({ eye, width, height, pixels }) => ({
    eye,
    width,
    height,
    png: width && height ? toPng(pixels, width, height) : null,
  }));
}

/** Each view's pixels, read from the layer the renderer drew this frame. */
function readViews(
  renderer: THREE.WebGLRenderer,
  views: readonly XRView[],
): { eye: string; width: number; height: number; pixels: Uint8Array }[] {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const layer = renderer.xr.getBaseLayer();
  if (!layer) {
    throw new Error("the session has no layer to read");
  }
  // Three keeps the binding it last made, so it gets it back.
  const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const scratch = "framebuffer" in layer ? null : gl.createFramebuffer();
  try {
    return views.map((view) => {
      const { x, y, width, height } = bindView(renderer, gl, layer, view, scratch);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { eye: view.eye, width, height, pixels };
    });
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
    gl.deleteFramebuffer(scratch);
  }
}

/**
 * Bind the framebuffer `view`'s image is in, and give its viewport: the
 * `XRWebGLLayer`'s own, or `scratch` with the colour texture of the view's
 * sub-image of a projection layer attached.
 */
function bindView(
  renderer: THREE.WebGLRenderer,
  gl: WebGL2RenderingContext,
  layer: XRWebGLLayer | XRProjectionLayer,
  view: XRView,
  scratch: WebGLFramebuffer | null,
): XRViewport {
  if ("framebuffer" in layer) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    return layer.getViewport(view) as XRViewport;
  }
  const image = renderer.xr.getBinding().getViewSubImage(layer, view);
  gl.bindFramebuffer(gl.FRAMEBUFFER, scratch);
  // Three asks for the side-by-side layer, one texture both views share.
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    image.colorTexture,
    0,
  );
  return image.viewport;
}

/** RGBA rows read bottom up, as a PNG the right way up. */
function toPng(pixels: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("no 2D context to encode the eye's image");
  }
  const image = context.createImageData(width, height);
  const row = width * 4;
  for (let y = 0; y < height; y += 1) {
    image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}
