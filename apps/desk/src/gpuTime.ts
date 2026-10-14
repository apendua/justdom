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
 * read once they are available. Every 300 timed frames the median and the
 * 90th percentile go to the console, which the headset's browser shows
 * through `chrome://inspect`. Without the extension it says so once and
 * times nothing; OVR Metrics Tool's GPU utilisation is the fallback then.
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
  const pending: WebGLQuery[] = [];
  const times: number[] = [];
  const render = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    const query = gl.createQuery();
    if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    render(scene, camera);
    if (query) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(query);
    }
    while (pending.length > 0 && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const done = pending.shift() as WebGLQuery;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        times.push(gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6);
      }
      gl.deleteQuery(done);
    }
    if (times.length >= 300) {
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      const p90 = times[Math.floor(times.length * 0.9)];
      console.log(
        `[gpuTime] ${label}: median ${median.toFixed(3)} ms, p90 ${p90.toFixed(3)} ms over ${times.length} frames`,
      );
      times.length = 0;
    }
  };
}
