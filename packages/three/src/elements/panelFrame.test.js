import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { flushFrame, frameCallbacks, nextMacrotask, pump, settle } from "../test/portalHarness.js";
import { clientRect } from "../test/clientRect.js";
import { createPortal } from "./portal.js";
import { getContentPosition } from "./mirror.js";
import { stagedRoot } from "../test/stagedRoot.js";
import { frameFor } from "./panelFrame.js";

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
 * `stagedRoot` left for a portal to claim, with the ids the warnings name
 * and each transform as the page writes it. No text: jsdom measures none.
 *
 * @param {object} transforms
 * @param {string} [transforms.root]
 * @param {string} [transforms.stage]
 */
function staged({ root: rootTransform = "", stage: stageTransform = "" } = {}) {
  const { stage, root } = stagedRoot();
  stage.id = "stage";
  stage.style.transform = stageTransform;
  root.id = "charts";
  root.style.transform = rootTransform;
  return { stage, root };
}

/**
 * `stagedRoot` with a root 300 by 200 holding one child laid out 100 px
 * across and 40 down, adopted by a mirror with no portal: the root, or what
 * is above it, changes by hand through `setScale`, and the test says which
 * event the mirror hears.
 */
function measuredRoot() {
  const staged = stagedRoot({ claimed: true });
  staged.place(staged.root, 0, 0, 300, 200);
  staged.place(staged.child, 100, 40, 50, 20);
  return { ...staged, mirror: staged.adopt() };
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

  test("a turn above the root that arrives with a resize warns on the next measurement", async () => {
    const { stage, root } = staged();
    const panel = await mirrored(root);
    try {
      await panel.load();
      assert.equal(panel.warnings.length, 0);
      stage.style.transform = TURNED;
      window.dispatchEvent(new window.Event("resize"));
      root.appendChild(document.createElement("div"));
      await pump();
      assert.equal(panel.warnings.length, 1, String(panel.warnings));
    } finally {
      panel.done();
      stage.remove();
    }
  });

  test("a turn on the root's own style after the claim warns", async () => {
    const { stage, root } = staged();
    const panel = await mirrored(root);
    try {
      await panel.load();
      root.style.transform = TURNED;
      await pump();
      root.appendChild(document.createElement("div"));
      await pump();
      assert.equal(panel.warnings.length, 1, String(panel.warnings));
    } finally {
      panel.done();
      stage.remove();
    }
  });

  test("a flip warns, and says it is a flip", async () => {
    const { stage, root } = staged({ root: "matrix(-1, 0, 0, 1, 0, 0)" });
    const panel = await mirrored(root);
    try {
      await panel.load();
      assert.equal(panel.warnings.length, 1, String(panel.warnings));
      assert.match(String(panel.warnings[0][0]), /a rotation, a skew, a flip or a perspective/);
    } finally {
      panel.done();
      stage.remove();
    }
  });

  test("a scale of 0 says nothing", async () => {
    const { stage, root } = staged({ root: "matrix(0, 0, 0, 0, 0, 0)" });
    const panel = await mirrored(root);
    try {
      await panel.load();
      assert.deepEqual(panel.warnings, []);
    } finally {
      panel.done();
      stage.remove();
    }
  });

  test("the chain above the root is not read again for a change inside the panel", async () => {
    // A panel that writes a style every frame, a gauge's needle say,
    // dispatches a mutation every frame. Nothing it hears can change what
    // is above its root, so none of them may cost a walk of that chain.
    const { stage, root } = staged({ stage: "matrix(0.5, 0, 0, 0.5, 0, 0)" });
    const panel = await mirrored(root);
    const original = window.getComputedStyle;
    let stageReads = 0;
    try {
      await panel.load();
      window.getComputedStyle = (element, pseudo) => {
        if (element === stage) {
          stageReads++;
        }
        return original.call(window, element, pseudo);
      };
      const box = /** @type {HTMLElement} */ (root.firstElementChild);
      for (let frame = 0; frame < 5; frame++) {
        box.style.width = `${10 + frame}px`;
        await pump();
      }
      assert.equal(stageReads, 0);
    } finally {
      window.getComputedStyle = original;
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

describe("a frame's scale", () => {
  test("divides by a matrix3d's projective weight", () => {
    const { stage, root, child } = stagedRoot({ claimed: true });
    root.style.transform = "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2)";
    try {
      const frame = frameFor(child);
      assert.deepEqual([frame.sx, frame.sy], [0.5, 0.5]);
    } finally {
      stage.remove();
    }
  });

  test("is the product of a scaled root on a scaled page", () => {
    const { stage, child, setScale } = measuredRoot();
    setScale("stage", 0.5);
    setScale("root", 1.2);
    // A scale on the child is one no rect follows, so the fixture refuses
    // it by its type.
    // @ts-expect-error -- only the stage and the root are drawn at a scale.
    void (() => setScale("child", 2));
    try {
      assert.deepEqual(getContentPosition(child), { x: 100, y: 40 });
    } finally {
      stage.remove();
    }
  });

  test("is not refused for a rotation of zero", () => {
    // An element at rest after a `rotate` animation computes to `0deg`.
    const { stage, root, setScale } = stagedRoot({ claimed: true });
    setScale("stage", 0.5);
    const original = window.getComputedStyle;
    const warn = console.warn;
    /** @type {unknown[]} */
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    window.getComputedStyle = (element, pseudo) => {
      const style = original.call(window, element, pseudo);
      if (element !== root) {
        return style;
      }
      return /** @type {CSSStyleDeclaration} */ (
        /** @type {unknown} */ ({ transform: "none", scale: "none", rotate: "1 1 1 0deg" })
      );
    };
    try {
      const frame = frameFor(root);
      assert.deepEqual([frame.sx, frame.sy], [0.5, 0.5]);
      assert.deepEqual(warnings, []);
    } finally {
      window.getComputedStyle = original;
      console.warn = warn;
      stage.remove();
    }
  });

  test("is 1 for a node in a document with no root element", () => {
    // A `<template>`'s content, or a document made with no root: what a
    // page may hand `setDragImage`.
    const empty = document.implementation.createDocument(null, null);
    const element = empty.createElementNS("http://www.w3.org/1999/xhtml", "div");
    const frame = frameFor(element);
    assert.deepEqual([frame.sx, frame.sy], [1, 1]);
  });
});

describe("a frame read again", () => {
  test("by a transition on the root's own transform, sampled by the clock", () => {
    // The clock reports a transform moving as a reflow of the element it
    // runs on, with no attribute changed.
    const { stage, root, child, mirror, setScale } = measuredRoot();
    try {
      assert.deepEqual(getContentPosition(child), { x: 100, y: 40 });
      setScale("root", 1.2);
      mirror.reflowed([root]);
      assert.deepEqual(getContentPosition(child), { x: 100, y: 40 });
    } finally {
      stage.remove();
    }
  });

  test("by a stylesheet that transforms what is above the root", () => {
    const { stage, child, mirror, setScale } = measuredRoot();
    try {
      assert.deepEqual(getContentPosition(child), { x: 100, y: 40 });
      setScale("stage", 0.5);
      mirror.documentStylesChanged();
      assert.deepEqual(getContentPosition(child), { x: 100, y: 40 });
    } finally {
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
    // way sixteen reads did before the frame existed. `mouse.js` is the one
    // exception: it reads the renderer's canvas to compare with a mouse
    // event's `clientX`, which is in the viewport's px, undivided.
    const allowed = new Set(["panelFrame.js", "mouse.js"]);
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
          !allowed.has(entry.name) &&
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
