import type { WebGLRenderer } from "three";

/**
 * Temporary, for item 10.2 of docs/freedom-architecture-plan.md: the GPU
 * time of each frame the scene renders, behind `?gpuTime`, so that Night
 * Ops can be timed with `?depthRank=constant` and with `?depthRank=slope`
 * on a headset. To be taken out with the depth probe once the numbers are
 * in.
 *
 * A frame is timed with `EXT_disjoint_timer_query_webgl2` around the
 * renderer's `render`, which a session calls once a frame for both eyes.
 * Results arrive a few frames late, so the queries are kept in flight and
 * read once they are available. Only the session's frames are timed. Every
 * 300 timed frames the median and the 90th percentile go to the console,
 * which the headset's browser shows through `chrome://inspect`. Without
 * the extension it says so once and times nothing; OVR Metrics Tool's GPU
 * utilisation is the fallback then.
 */
export function timeGpu(renderer: WebGLRenderer, label: string): void {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null;
  if (!ext) {
    console.warn("[gpuTime] EXT_disjoint_timer_query_webgl2 is not exposed here");
    return;
  }
  // A ring of queries made once, and the times in an array of fixed size,
  // so that the timer allocates nothing a frame. A query is reused once its
  // result is read; one still in flight when its turn comes round skips
  // that frame.
  const ring = Array.from({ length: 8 }, () => gl.createQuery() as WebGLQuery);
  const inFlight = new Array<boolean>(ring.length).fill(false);
  let next = 0;
  let oldest = 0;
  const times = new Float64Array(300);
  let count = 0;
  const render = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    // Only the session's frames: a drag ghost's snapshot renders into a
    // target of its own and is not a frame.
    const timed =
      renderer.xr.isPresenting && renderer.getRenderTarget() === null && !inFlight[next];
    if (timed) gl.beginQuery(ext.TIME_ELAPSED_EXT, ring[next]);
    render(scene, camera);
    if (timed) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      inFlight[next] = true;
      next = (next + 1) % ring.length;
    }
    while (inFlight[oldest] && gl.getQueryParameter(ring[oldest], gl.QUERY_RESULT_AVAILABLE)) {
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        times[count++] = gl.getQueryParameter(ring[oldest], gl.QUERY_RESULT) / 1e6;
      }
      inFlight[oldest] = false;
      oldest = (oldest + 1) % ring.length;
      if (count === times.length) {
        times.sort();
        const median = times[Math.floor(count / 2)];
        const p90 = times[Math.floor(count * 0.9)];
        console.log(
          `[gpuTime] ${label}: median ${median.toFixed(3)} ms, p90 ${p90.toFixed(3)} ms over ${count} frames`,
        );
        count = 0;
      }
    }
  };
}
