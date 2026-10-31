/**
 * Phase 1's count on its jsdom scenes (`src/test/paintOrderScenes.js`):
 * the 800-row list and the three 100-card boards of `mirror.bench.js`, a
 * handful of layers the bench has none of, and five things a page holds
 * that freedom draws nothing of.
 *
 *   node --import ./src/test/setup-jsdom.js bench/paintOrderCount.jsdom.mjs
 *
 * Prints one Markdown table per group, in `paintOrderCount.js`'s columns.
 */

import { formatCounts } from "../src/test/paintOrderCount.js";
import {
  BENCH_SCENES,
  countScene,
  HIDDEN_SCENES,
  LAYER_SCENES,
} from "../src/test/paintOrderScenes.js";

for (const [title, scenes] of /** @type {const} */ ([
  ["the bench's scenes", BENCH_SCENES],
  ["layers out of the plane", LAYER_SCENES],
  ["what a page holds and freedom draws nothing of", HIDDEN_SCENES],
])) {
  /** @type {[string, import("../src/test/paintOrderCount.js").PanelCount][]} */
  const rows = [];
  for (const { name, build } of scenes) {
    rows.push([name, await countScene(build)]);
  }
  console.log(`\n=== ${title} ===\n`);
  console.log(formatCounts(rows));
}
