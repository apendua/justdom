import * as THREE from "three";
import { MINUTE, memoizeWithTTL, onCleanup } from "@apendua/signal";

/**
 * The board's materials, one per appearance rather than one per figure.
 *
 * Everything on the paper is drawn by an effect that also does the figure's
 * geometry, and those effects re-run constantly: a line re-clips itself to the
 * viewport on every frame of a pan, a point re-scales itself, the rubber bands
 * and the snap ring follow the cursor every frame whether or not anything is
 * being drawn, and a change of selection re-runs every figure at once. Built
 * inline, that meant a new material per figure per run, with the one it
 * replaced disposed on the way out. Panning for six seconds built and threw
 * away 2004 `LineBasicMaterial`s, 1026 `MeshBasicMaterial`s and 1026 textured
 * label materials; a board sitting still with nobody touching it managed 334 a
 * second on its own, for the preview layer alone.
 *
 * That was garbage rather than recompiles — three keys its program cache on
 * what a material is rather than on which one it is, and the preview layer
 * always holds a live `LineBasicMaterial`, so the program never lost its last
 * holder and never had to be built again. What it cost was the allocation, the
 * collection, and the renderer's per-material bookkeeping, every frame, on a
 * headset. Memoized by appearance the effect looks a material up instead, and
 * assigning the same instance again is a no-op: zero built during the same pan.
 *
 * The window is what carries a colour across a gap where nothing is wearing
 * it — deselecting the only selected figure strands `highlight` until the next
 * selection — and that gap is where a dispose would cost a recompile, because
 * a colour nothing else is using takes the program with it.
 */
export const lineMaterial = memoizeWithTTL(MINUTE, (color: string) => {
  const material = new THREE.LineBasicMaterial({ color });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});

export const meshMaterial = memoizeWithTTL(MINUTE, (color: string, opacity: number = 1) => {
  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: opacity < 1,
    opacity,
  });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});
