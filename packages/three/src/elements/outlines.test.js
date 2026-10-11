import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "./portal.js";
import { classify, enableOutlinesMode, outlinesReport, rampColor } from "./outlines.js";
import { drain, flushFrame, nextMacrotask, settle } from "../test/portalHarness.js";

/**
 * A panel the page already has: a list of four rows, each a plain box with
 * an id to find it by in the report. Boxes rather than text, since jsdom
 * lays out no text.
 */
async function rowsPanel() {
  const root = document.createElement("div");
  const list = document.createElement("div");
  const rows = Array.from({ length: 4 }, (_, i) => {
    const row = document.createElement("div");
    row.id = `row${i}`;
    row.style.backgroundColor = "rgb(0, 2, 3)";
    return row;
  });
  list.append(...rows);
  root.append(list);
  document.body.append(root);
  const ctx = InteractionContext.set({}, new InteractionManager());
  const portal = createPortal(ctx, {
    root,
    budget: 0,
    loadingFrame: { delay: 0, minimumTime: 0 },
  });
  const parent = new THREE.Group();
  portal.addTo(parent);
  const containerObject = parent.children[0];
  await settle(portal);
  return {
    list,
    rows,
    containerObject,
    /**
     * How many outlines the panel draws in each style, or null while it has
     * no overlay.
     */
    drawn() {
      const overlay = containerObject.children.find((child) =>
        child.children.some((line) => line instanceof THREE.LineSegments),
      );
      if (!overlay) {
        return null;
      }
      const [solid, dashed, dotted] = /** @type {THREE.LineSegments[]} */ (overlay.children);
      return {
        solid: solid.geometry.drawRange.count / 8,
        dashed: dashed.geometry.drawRange.count / 8,
        dotted: dotted.geometry.drawRange.count / 8,
        solidColor: () => {
          const colors = solid.geometry.getAttribute("color");
          return new THREE.Color(colors.getX(0), colors.getY(0), colors.getZ(0));
        },
      };
    },
    /** How many boxes the panel's batches draw red. */
    red() {
      let count = 0;
      for (const child of containerObject.children) {
        if (!(child instanceof THREE.InstancedMesh)) {
          continue;
        }
        const fill = child.geometry.getAttribute("aFillColor");
        for (let index = 0; index < child.count; index++) {
          if (fill.getX(index) === 1) {
            count += 1;
          }
        }
      }
      return count;
    },
    async dispose() {
      await drain();
      portal.disconnect();
      root.remove();
    },
  };
}

/**
 * The report's row for the element with `id`.
 *
 * @param {string} id
 */
function reported(id) {
  return outlinesReport(Infinity).find((row) => row.element.endsWith(`#${id}`));
}

describe("outlines mode", () => {
  test("a change is outlined in the frame that draws it, and not before", async () => {
    // The panel is atomic, so it shows the page as it was at its last
    // commit. An outline taken when the page changed would stand round a row
    // that is still drawn the old colour. A zero budget spreads the commit
    // over frames, and in every frame the outline and the colour agree.
    const panel = await rowsPanel();
    const off = enableOutlinesMode();
    try {
      assert.deepEqual(
        { ...panel.drawn(), solidColor: undefined },
        { solid: 0, dashed: 0, dotted: 0, solidColor: undefined },
        "a panel built before the mode was on gets an overlay, empty",
      );
      panel.rows[0].style.backgroundColor = "rgb(255, 2, 3)";
      await nextMacrotask();
      let frames = 0;
      while (frames < 200 && panel.red() === 0) {
        assert.equal(panel.drawn()?.solid, 0, `no outline before the commit, frame ${frames}`);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(panel.red(), 1, "the row is drawn red");
      assert.equal(panel.drawn()?.solid, 1, "and outlined in the same frame");
      assert.deepEqual(
        panel.drawn()?.solidColor().getHex(),
        rampColor(1).getHex(),
        "once a second or less",
      );
      const row = reported("row0");
      assert.equal(row?.changes, 1);
      assert.equal(row?.commits, 1);
    } finally {
      off();
      await panel.dispose();
    }
  });

  test("a write of what is already there is a grey line", async () => {
    // The mirror drops it, and nothing is left for the panel to do, so no
    // commit comes. The outline goes up with the flush instead.
    const panel = await rowsPanel();
    panel.rows[1].setAttribute("data-state", "idle");
    await drain();
    const off = enableOutlinesMode();
    try {
      panel.rows[1].setAttribute("data-state", "idle");
      await nextMacrotask();
      assert.equal(panel.drawn()?.solid, 1);
      assert.equal(panel.drawn()?.solidColor().getHexString(), "9ca3af");
      assert.deepEqual(
        { changes: reported("row1")?.changes, noopWrites: reported("row1")?.noopWrites },
        { changes: 0, noopWrites: 1 },
      );
    } finally {
      off();
      await panel.dispose();
    }
  });

  test("rows a new first row told they moved, and that had not, are dotted", async () => {
    // jsdom lays nothing out, so every row measures where it was. The layout
    // walk tells each row after the new one that it may have moved, the
    // mirror measures each again, and each comes out the same: invalidated
    // for nothing, which is what the dotted line is for.
    const panel = await rowsPanel();
    const off = enableOutlinesMode();
    try {
      panel.list.prepend(document.createElement("div"));
      await drain();
      for (const row of panel.rows) {
        const counted = reported(row.id);
        assert.ok(counted, `${row.id} was counted`);
        assert.equal(counted.changes, 0, `${row.id} was not touched by the page`);
        assert.ok(counted.ripples >= 1, `${row.id} was told it may have moved`);
        assert.ok(counted.recalculated >= 1, `${row.id} was measured again`);
        assert.equal(counted.unchanged, counted.recalculated, `${row.id} measured the same`);
      }
      assert.ok((panel.drawn()?.dotted ?? 0) >= 4, "and each is dotted");
    } finally {
      off();
      await panel.dispose();
    }
  });

  test("a box that inherits a colour its row changed is dashed", async () => {
    // The page touched the row and not the box inside it, and the box is
    // drawn differently all the same: a ripple, and not a wasted read.
    const panel = await rowsPanel();
    const label = document.createElement("div");
    label.id = "label";
    panel.rows[3].append(label);
    await drain();
    const off = enableOutlinesMode();
    try {
      panel.rows[3].style.color = "rgb(255, 0, 0)";
      await drain();
      const counted = reported("label");
      assert.ok(counted, "the box was counted");
      assert.equal(counted.changes, 0, "the page did not touch it");
      assert.ok(counted.recalculated > counted.unchanged, "and something read for it changed");
      assert.equal(panel.drawn()?.dashed, 1, "so it is dashed");
      assert.equal(reported("row3")?.changes, 1, "round the row it inherits from, solid");
    } finally {
      off();
      await panel.dispose();
    }
  });

  test("turning the mode off takes the overlay away and stops counting", async () => {
    const panel = await rowsPanel();
    const off = enableOutlinesMode();
    off();
    try {
      assert.equal(panel.drawn(), null);
      panel.rows[2].style.backgroundColor = "rgb(255, 2, 3)";
      await drain();
      assert.equal(reported("row2"), undefined);
    } finally {
      await panel.dispose();
    }
  });

  test("a commit sees an element by the strongest thing that happened to it", () => {
    const none = { changes: 0, noopWrites: 0, ripples: 0, recalculated: 0, unchanged: 0 };
    assert.equal(classify({ ...none, changes: 1, recalculated: 3 }), "changed");
    assert.equal(classify({ ...none, ripples: 1, recalculated: 3, unchanged: 2 }), "ripple");
    assert.equal(classify({ ...none, ripples: 1, recalculated: 3, unchanged: 3 }), "wasted");
    assert.equal(classify({ ...none, noopWrites: 2 }), "noop");
    assert.equal(classify({ ...none, ripples: 1 }), null, "told it moved and never read");
  });

  test("the colour runs from blue to red with how often", () => {
    assert.equal(rampColor(0.5).getHexString(), "3b82f6");
    assert.equal(rampColor(3).getHexString(), "22c55e");
    assert.equal(rampColor(7).getHexString(), "eab308");
    assert.equal(rampColor(30).getHexString(), "ef4444");
  });
});
