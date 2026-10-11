import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Signal, UpdateChannel, withChannel } from "@apendua/signal";
import { createMirror } from "./mirror.js";
import { text } from "./text.js";
import { createTextBatch, TextBatchContext } from "./textBatch.js";
import { holdsStep, stepBelow, TextScaleContext } from "./textScale.js";
import { createTextPreparer, TextPrepareContext } from "./textPrepare.js";
import { createPortalScheduler } from "./portalScheduler.js";
import { installRange } from "../test/textRange.js";

/**
 * @import {TextBatch} from './textBatch.js';
 * @import {TextPreparer} from './textPrepare.js';
 */

describe("text visibility", () => {
  test("a run follows its parent's visibility, which a nested element can override", () => {
    const restore = installRange();
    const outer = document.createElement("div");
    outer.style.visibility = "hidden";
    const inner = document.createElement("span");
    outer.append("hidden", inner);
    inner.append("shown");
    document.body.appendChild(outer);
    const mirror = createMirror();
    mirror.adopt(outer);

    try {
      /**
       * @param {Text} node
       */
      const project = (node) => {
        mirror.adopt(node);
        /** @type {THREE.Object3D | undefined} */
        let object;
        const subscription = text({}, node).subscribe({
          next: (value) => {
            object = value;
          },
        });
        assert.ok(object);
        const mesh = object.children[0];
        assert.ok(mesh instanceof THREE.Mesh);
        return { mesh, subscription };
      };
      mirror.adopt(inner);
      const hidden = project(/** @type {Text} */ (outer.firstChild));
      const nested = project(/** @type {Text} */ (inner.firstChild));

      // Inherited: the span says nothing, so its text is hidden with the div's.
      assert.equal(hidden.mesh.visible, false);
      assert.equal(nested.mesh.visible, false);

      inner.style.visibility = "visible";
      mirror.attributeChanged(inner);
      assert.equal(hidden.mesh.visible, false);
      assert.equal(nested.mesh.visible, true, "the span shows its own text again");

      outer.style.visibility = "";
      mirror.attributeChanged(outer);
      assert.equal(hidden.mesh.visible, true);
      assert.equal(nested.mesh.visible, true);

      hidden.subscription.unsubscribe();
      nested.subscription.unsubscribe();
    } finally {
      restore();
      outer.remove();
    }
  });
});

describe("text opacity", () => {
  test("a run is faded by the opacity of every element it is in, and follows it", () => {
    const restore = installRange();
    const outer = document.createElement("div");
    outer.style.opacity = "0.5";
    const inner = document.createElement("span");
    inner.style.opacity = "0.5";
    inner.style.color = "rgb(0, 0, 0)";
    outer.append(inner);
    inner.append("faded");
    document.body.appendChild(outer);
    const mirror = createMirror();
    mirror.adopt(outer);
    mirror.adopt(inner);
    const node = /** @type {Text} */ (inner.firstChild);
    mirror.adopt(node);

    try {
      /** @type {THREE.Object3D | undefined} */
      let object;
      const subscription = text({}, node).subscribe({
        next: (value) => {
          object = value;
        },
      });
      assert.ok(object);
      const mesh = /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>} */ (
        object.children[0]
      );
      assert.equal(mesh.material.opacity, 0.25, "both elements fade it, as on a page");

      outer.style.opacity = "";
      mirror.attributeChanged(outer);
      assert.equal(mesh.material.opacity, 0.5, "and the outer one stops fading it");

      subscription.unsubscribe();
    } finally {
      restore();
      outer.remove();
    }
  });

  test("a run with its colours baked in is faded all the same", () => {
    // A shadow turns the mask off: the run's colours are in its texture,
    // and the material carries the fade alone.
    const restore = installRange();
    const outer = document.createElement("div");
    outer.style.opacity = "0.5";
    const inner = document.createElement("span");
    inner.style.opacity = "0.5";
    inner.style.textShadow = "1px 1px 0 rgb(255, 0, 0)";
    outer.append(inner);
    inner.append("shadowed");
    document.body.appendChild(outer);
    const mirror = createMirror();
    mirror.adopt(outer);
    mirror.adopt(inner);
    const node = /** @type {Text} */ (inner.firstChild);
    mirror.adopt(node);

    try {
      /** @type {THREE.Object3D | undefined} */
      let object;
      const subscription = text({}, node).subscribe({
        next: (value) => {
          object = value;
        },
      });
      assert.ok(object);
      const mesh = /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>} */ (
        object.children[0]
      );
      assert.equal(mesh.material.alphaMap, null, "baked, not masked");
      assert.equal(mesh.material.opacity, 0.25);
      subscription.unsubscribe();
    } finally {
      restore();
      outer.remove();
    }
  });
});

/**
 * A panel's text scale, moved by hand: it shows `step`, and holds what a
 * panel does, the shown step and the one below it.
 */
function handScale() {
  const published = Signal.of(1);
  let shown = 1;
  /** @type {number | null} */
  let preparing = null;
  return {
    read: () => published.get(),
    holds: (/** @type {number} */ step) => holdsStep(shown, step, preparing),
    /** @param {number} step */
    show(step) {
      shown = step;
      preparing = null;
      published.set(step);
    },
    /** @param {number | null} step */
    prepare(step) {
      preparing = step;
    },
  };
}

/**
 * One text node, projected with `scale` on its context, and what it is
 * drawn with.
 *
 * @param {ReturnType<typeof handScale>} scale
 * @param {{
 *   withBatch?: (container: THREE.Object3D) => TextBatch,
 *   channel?: UpdateChannel,
 *   withPreparer?: (batch: TextBatch | null) => TextPreparer,
 *   textShadow?: string,
 * }} [options] A batch to draw it, the channel its effects run in, as a
 *   portal's do, the pump that prepares it, and a shadow, which bakes the
 *   run's colours in.
 */
function steppedRun(scale, { withBatch, channel, withPreparer, textShadow = "" } = {}) {
  const restore = installRange();
  const element = document.createElement("span");
  element.style.textShadow = textShadow;
  element.append("label");
  document.body.appendChild(element);
  const mirror = createMirror();
  mirror.adopt(element);
  const node = /** @type {Text} */ (element.firstChild);
  mirror.adopt(node);
  const container = new THREE.Group();
  const batch = withBatch?.(container) ?? null;
  /** @type {WeakKey} */
  let ctx = TextScaleContext.set({}, scale);
  if (batch) {
    ctx = TextBatchContext.set(ctx, batch);
  }
  const preparer = withPreparer?.(batch) ?? null;
  if (preparer) {
    ctx = TextPrepareContext.set(ctx, preparer);
  }
  /** @type {THREE.Object3D | undefined} */
  let object;
  const project = () =>
    text(ctx, node).subscribe({
      next: (value) => {
        object = value;
      },
    });
  const subscription = channel ? withChannel(channel, project) : project();
  assert.ok(object);
  container.add(object);
  const mesh = /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>} */ (
    object.children[0]
  );
  /** @type {Set<THREE.Texture>} */
  const disposed = new Set();
  /** The texture the run draws, watched for its disposal. */
  const shown = () => {
    const texture = /** @type {THREE.Texture} */ (mesh.material.alphaMap);
    texture.addEventListener("dispose", () => {
      disposed.add(texture);
    });
    return texture;
  };
  return {
    node,
    mirror,
    mesh,
    batch,
    preparer,
    container,
    shown,
    disposed,
    done: () => {
      subscription.unsubscribe();
      restore();
      element.remove();
    },
  };
}

describe("text steps", () => {
  test("a run shows again the raster it kept for the step below, without drawing it", () => {
    const scale = handScale();
    const run = steppedRun(scale);
    try {
      const coarse = run.shown();
      scale.show(Math.SQRT2);
      const fine = run.shown();
      assert.notEqual(fine, coarse);
      assert.equal(run.disposed.size, 0, "1 is the step below 1.41");

      scale.show(1);
      assert.equal(run.shown(), coarse);
      assert.deepEqual([...run.disposed], [fine], "a step above the shown one is not held");
    } finally {
      run.done();
    }
  });

  test("a raster at a step the panel lets go of is disposed", () => {
    const scale = handScale();
    const run = steppedRun(scale);
    try {
      const one = run.shown();
      scale.show(Math.SQRT2);
      const root = run.shown();
      scale.show(2);
      assert.deepEqual([...run.disposed], [one], "1 is two steps under 2");
      scale.show(stepBelow(4) ?? 0);
      assert.deepEqual([...run.disposed], [one, root]);
    } finally {
      run.done();
    }
  });

  test("a change of what the run says drops every raster it held", () => {
    const scale = handScale();
    const run = steppedRun(scale);
    try {
      const coarse = run.shown();
      scale.show(Math.SQRT2);
      const fine = run.shown();

      run.node.data = "another label";
      run.mirror.characterDataChanged(run.node);
      const redrawn = run.shown();
      assert.notEqual(redrawn, fine);
      assert.deepEqual(new Set(run.disposed), new Set([coarse, fine]));

      scale.show(1);
      const again = run.shown();
      assert.notEqual(again, coarse, "the held step is drawn again, from what it says now");
    } finally {
      run.done();
    }
  });

  test("under an atomic channel, a raster let go of is disposed at the commit, not before", () => {
    const scale = handScale();
    const channel = new UpdateChannel({ name: "panel", order: 1, manual: true, atomic: true });
    const run = steppedRun(scale, { channel });
    try {
      const coarse = run.shown();
      scale.show(Math.SQRT2);
      channel.flush();
      const fine = run.shown();

      run.node.data = "another label";
      run.mirror.characterDataChanged(run.node);
      channel.warm();
      assert.equal(run.mesh.material.alphaMap, fine, "the commit has not happened");
      assert.equal(run.disposed.size, 0, "so nothing it may still draw has gone");

      channel.flush();
      assert.notEqual(run.shown(), fine);
      assert.deepEqual(new Set(run.disposed), new Set([coarse, fine]));
    } finally {
      run.done();
    }
  });

  test("a run taken down disposes every raster it kept", () => {
    const scale = handScale();
    const run = steppedRun(scale);
    const coarse = run.shown();
    scale.show(Math.SQRT2);
    const fine = run.shown();
    run.done();
    assert.deepEqual(new Set(run.disposed), new Set([coarse, fine]));
  });

  test("a raster let go of gives back its layer in the batch", () => {
    const scale = handScale();
    /** @type {THREE.Object3D | null} */
    let panel = null;
    const run = steppedRun(scale, {
      withBatch: (container) => {
        panel = container;
        return createTextBatch(container);
      },
    });
    /** The array texture the run's bucket samples. */
    const array = () => {
      const bucket = /** @type {THREE.InstancedMesh | undefined} */ (
        /** @type {THREE.Object3D} */ (panel).children.find(
          (c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh && c.visible,
        )
      );
      assert.ok(bucket);
      return /** @type {THREE.ShaderMaterial} */ (bucket.material).uniforms.uRuns.value;
    };
    try {
      const batch = /** @type {TextBatch} */ (run.batch);
      batch.flush();
      const first = array();
      let released = false;
      first.addEventListener("dispose", () => {
        released = true;
      });
      scale.show(Math.SQRT2);
      batch.flush();
      assert.equal(released, false, "the raster at 1 is held, and so is its layer");
      scale.show(2);
      batch.flush();
      assert.equal(released, true, "no run holds a raster at 1 any more");
    } finally {
      run.done();
    }
  });
});

/**
 * A run on a panel that prepares steps ahead: a batch, a prepare pump paced
 * by a scheduler whose frames the test runs by hand with all the time in the
 * world, and every array the pump sent up.
 *
 * @param {ReturnType<typeof handScale>} scale
 * @param {{
 *   budget?: number,
 *   now?: () => number,
 *   textShadow?: string,
 * }} [options] The frame's budget, and the clock the pump reads its deadline
 *   on, all the time in the world by default; and the run's shadow.
 */
function preparedRun(scale, { budget = Infinity, now = () => 0, textShadow } = {}) {
  /** @type {(() => void) | null} */
  let tick = null;
  const scheduler = createPortalScheduler({
    budget,
    now: () => 0,
    requestFrames: (callback) => {
      tick = callback;
      return () => {
        tick = null;
      };
    },
  });
  /** @type {THREE.Texture[]} */
  const uploaded = [];
  const run = steppedRun(scale, {
    textShadow,
    withBatch: (container) => createTextBatch(container),
    withPreparer: (batch) =>
      createTextPreparer({
        scheduler,
        batch: /** @type {TextBatch} */ (batch),
        holds: scale.holds,
        upload: (texture) => {
          uploaded.push(texture);
        },
        now,
      }),
  });
  const batch = /** @type {TextBatch} */ (run.batch);
  const preparer = /** @type {TextPreparer} */ (run.preparer);
  batch.flush();
  /** The panel's step `step` is prepared, and a frame runs the pump. */
  const prepare = (/** @type {number | null} */ step) => {
    scale.prepare(step);
    preparer.retarget(step);
    /** @type {(() => void) | null} */ (tick)?.();
  };
  /** The array texture the run's visible bucket samples. */
  const array = () => {
    const bucket = /** @type {THREE.InstancedMesh | undefined} */ (
      run.container.children.find(
        (c) =>
          /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh &&
          /** @type {THREE.InstancedMesh} */ (c).count > 0,
      )
    );
    assert.ok(bucket);
    return /** @type {THREE.ShaderMaterial} */ (bucket.material).uniforms.uRuns.value;
  };
  return { run, batch, preparer, prepare, uploaded, array, running: () => tick !== null };
}

/**
 * Count the canvases made while `fn` runs, which is one per raster drawn.
 *
 * @param {() => void} fn
 * @returns {number}
 */
function canvasesMade(fn) {
  const real = document.createElement;
  let made = 0;
  // Counting one tag, restored below.
  document.createElement = (/** @type {string} */ tag, /** @type {unknown} */ options) => {
    if (tag === "canvas") {
      made += 1;
    }
    return real.call(document, tag, /** @type {ElementCreationOptions} */ (options));
  };
  try {
    fn();
  } finally {
    document.createElement = real;
  }
  return made;
}

describe("prepared text steps", () => {
  test("a step prepared ahead is shown at the crossing without drawing, copying or uploading", () => {
    const scale = handScale();
    const p = preparedRun(scale);
    try {
      p.prepare(Math.SQRT2);
      assert.equal(p.uploaded.length, 1, "the prepared step's array went up ahead");
      const [ahead] = p.uploaded;
      let rebuilt = false;
      ahead.addEventListener("dispose", () => {
        rebuilt = true;
      });

      const drawn = canvasesMade(() => {
        scale.show(Math.SQRT2);
        p.preparer.retarget(null);
        p.batch.flush();
      });
      assert.equal(drawn, 0, "the run was drawn at 1.41 already");
      assert.equal(p.array(), ahead, "and drawn from the array that went up");
      assert.equal(rebuilt, false);
      assert.equal(p.uploaded.length, 1);
    } finally {
      p.run.done();
    }
  });

  test("a crossing before the pump sent the arrays up draws from an array built for it", () => {
    const scale = handScale();
    // The pump's clock passes the deadline after the first run it prepares,
    // so it never reaches its upload.
    let time = 0;
    const p = preparedRun(scale, { budget: 1, now: () => time++ });
    try {
      p.prepare(Math.SQRT2);
      assert.equal(p.uploaded.length, 0, "the pump stopped before its upload");

      scale.show(Math.SQRT2);
      p.preparer.retarget(null);
      p.batch.flush();
      const array = p.array();
      assert.ok(array, "the run is drawn from an array, not from nothing");
      assert.equal(
        array.image.width,
        /** @type {THREE.Texture} */ (p.run.mesh.material.alphaMap).image.width,
      );
    } finally {
      p.run.done();
    }
  });

  test("a run with its colours baked in is sent up by the pump itself", () => {
    const scale = handScale();
    const p = preparedRun(scale, { textShadow: "1px 1px 0 rgb(255, 0, 0)" });
    try {
      assert.equal(p.run.mesh.material.alphaMap, null, "baked, so the batch declines it");
      p.prepare(Math.SQRT2);
      assert.equal(p.uploaded.length, 1);
      scale.show(Math.SQRT2);
      assert.equal(p.run.mesh.material.map, p.uploaded[0], "the texture shown is the one sent up");
    } finally {
      p.run.done();
    }
  });

  test("letting the step go stops the pump asking for frames", () => {
    const scale = handScale();
    let time = 0;
    const p = preparedRun(scale, { budget: 1, now: () => time++ });
    try {
      p.prepare(Math.SQRT2);
      assert.equal(p.running(), true, "stopped before its upload, so still waiting");
      p.preparer.retarget(null);
      assert.equal(p.running(), false);
    } finally {
      p.run.done();
    }
  });

  test("a step let go of before the crossing frees what was made for it", () => {
    const scale = handScale();
    const p = preparedRun(scale);
    try {
      const shown = p.run.shown();
      p.prepare(Math.SQRT2);
      const [ahead] = p.uploaded;
      let freed = false;
      ahead.addEventListener("dispose", () => {
        freed = true;
      });

      p.prepare(null);
      p.batch.flush();
      assert.equal(freed, true, "no run holds a layer at 1.41 any more");
      assert.equal(p.run.disposed.has(shown), false, "and the shown raster stays");
      const drawn = canvasesMade(() => {
        scale.show(Math.SQRT2);
      });
      assert.equal(drawn, 1, "so crossing draws it again");
    } finally {
      p.run.done();
    }
  });

  test("a run whose content changes is prepared again from what it says now", () => {
    const scale = handScale();
    const p = preparedRun(scale);
    try {
      p.prepare(Math.SQRT2);
      assert.equal(p.uploaded.length, 1);

      p.run.node.data = "another label";
      p.run.mirror.characterDataChanged(p.run.node);
      p.prepare(Math.SQRT2);
      assert.equal(p.uploaded.length, 2, "queued again, drawn again and sent up again");

      const drawn = canvasesMade(() => {
        scale.show(Math.SQRT2);
      });
      assert.equal(drawn, 0);
    } finally {
      p.run.done();
    }
  });
});
