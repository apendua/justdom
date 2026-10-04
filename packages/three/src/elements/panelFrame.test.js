import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { flushFrame, frameCallbacks, nextMacrotask, pump, settle } from "../test/portalHarness.js";
import { clientRect } from "../test/clientRect.js";
import { createPortal } from "./portal.js";
import { getContentPosition } from "./mirror.js";

/**
 * Mirror `root` into a panel and let it load, with every `console.warn` the
 * portal says kept, until `done` puts `console.warn` back.
 *
 * @param {HTMLElement} root
 * @param {object} [options]
 * @param {number} [options.budget]
 */
async function mirrored(root, { budget } = {}) {
  /** @type {unknown[][]} */
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => {
    warnings.push(args);
  };
  const ctx = InteractionContext.set({}, new InteractionManager());
  const portal = createPortal(ctx, { root, ...(budget === undefined ? {} : { budget }) });
  portal.addTo(new THREE.Group());
  return {
    portal,
    warnings,
    load: () => settle(portal),
    done() {
      console.warn = original;
      portal.disconnect();
    },
  };
}

/**
 * A root with one box in it, inside a stage on the page. No text: jsdom
 * measures none.
 *
 * @param {object} transforms
 * @param {string} [transforms.root]
 * @param {string} [transforms.stage]
 */
function staged({ root: rootTransform = "", stage: stageTransform = "" } = {}) {
  const stage = document.createElement("div");
  stage.id = "stage";
  stage.style.transform = stageTransform;
  const root = document.createElement("div");
  root.id = "charts";
  root.style.transform = rootTransform;
  root.appendChild(document.createElement("div"));
  stage.appendChild(root);
  document.body.appendChild(stage);
  return { stage, root };
}

describe("a panel's root on a transformed chain", () => {
  const TURNED = "matrix(0.866, 0.5, -0.5, 0.866, 0, 0)";

  test("a turned root warns once, naming itself", async () => {
    const { stage, root } = staged({ root: TURNED });
    const panel = await mirrored(root);
    try {
      await panel.load();
      root.appendChild(document.createElement("div"));
      await pump();
      assert.equal(panel.warnings.length, 1, String(panel.warnings));
      assert.match(
        String(panel.warnings[0][0]),
        /div#charts is mirrored through a transform on div#charts/,
      );
    } finally {
      panel.done();
      stage.remove();
    }
  });

  test("a turned ancestor warns, naming the ancestor", async () => {
    const { stage, root } = staged({ stage: TURNED });
    const panel = await mirrored(root);
    try {
      await panel.load();
      assert.equal(panel.warnings.length, 1, String(panel.warnings));
      assert.match(
        String(panel.warnings[0][0]),
        /div#charts is mirrored through a transform on div#stage/,
      );
    } finally {
      panel.done();
      stage.remove();
    }
  });

  test("a turn that arrives after the claim warns when the panel next measures", async () => {
    const { stage, root } = staged();
    const panel = await mirrored(root);
    try {
      await panel.load();
      assert.equal(panel.warnings.length, 0);
      stage.style.transform = TURNED;
      root.appendChild(document.createElement("div"));
      await pump();
      assert.equal(panel.warnings.length, 1, String(panel.warnings));
    } finally {
      panel.done();
      stage.remove();
    }
  });

  test("a scaled root and a scaled ancestor say nothing", async () => {
    const { stage, root } = staged({
      root: "matrix(0.5, 0, 0, 0.5, 0, 0)",
      stage: "matrix(2, 0, 0, 2, 30, 40)",
    });
    const panel = await mirrored(root);
    try {
      await panel.load();
      assert.deepEqual(panel.warnings, []);
    } finally {
      panel.done();
      stage.remove();
    }
  });
});

describe("the page scrolling", () => {
  test("mid-mount, does not leave half a panel measured before it", async () => {
    // A panel that takes several frames to build, on a page whose window
    // scrolls between two of them. Every client rect moves with the
    // scroll; a rect read before it must not be subtracted from one read
    // after it.
    const root = document.createElement("div");
    const rows = Array.from({ length: 12 }, () => {
      const row = document.createElement("div");
      root.appendChild(row);
      return row;
    });
    let scrolled = 0;
    root.getBoundingClientRect = () => clientRect(0, 100 - scrolled, 300, 480);
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => clientRect(0, 100 - scrolled + index * 40, 300, 40);
    });
    document.body.appendChild(root);
    const panel = await mirrored(root, { budget: 0 });
    try {
      await nextMacrotask();
      flushFrame();
      await nextMacrotask();
      assert.ok(frameCallbacks.length > 0, "the mount is still going");
      scrolled = 60;
      window.dispatchEvent(new window.Event("scroll"));
      await panel.load();
      assert.deepEqual(
        rows.map((row) => getContentPosition(row).y),
        rows.map((_, index) => index * 40),
      );
    } finally {
      panel.done();
      root.remove();
    }
  });
});

describe("client rects", () => {
  test("are read by panelFrame.js and by no other module", () => {
    // Every rect a panel is measured from has to be divided by the scale
    // the page draws the panel at. A read anywhere else skips that, the
    // way sixteen reads did before the frame existed.
    const src = new URL("../", import.meta.url);
    /** @type {string[]} */
    const readers = [];
    /** @param {URL} dir */
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
        if (entry.isDirectory()) {
          if (entry.name !== "test") {
            walk(url);
          }
        } else if (
          entry.name.endsWith(".js") &&
          !entry.name.endsWith(".test.js") &&
          !entry.name.endsWith(".bench.js") &&
          entry.name !== "panelFrame.js" &&
          /\.(getBoundingClientRect|getClientRects)\b/.test(readFileSync(url, "utf8"))
        ) {
          readers.push(url.pathname.slice(src.pathname.length));
        }
      }
    }
    walk(src);
    assert.deepEqual(readers, []);
  });
});
