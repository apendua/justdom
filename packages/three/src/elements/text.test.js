import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Signal, UpdateChannel, withChannel } from "@apendua/signal";
import { createMirror } from "./mirror.js";
import { text } from "./text.js";
import { createTextBatch, TextBatchContext } from "./textBatch.js";
import { holdsStep, stepBelow, TextScaleContext } from "./textScale.js";
import { installRange } from "../test/textRange.js";

/**
 * @import {TextBatch} from './textBatch.js';
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
  return {
    read: () => published.get(),
    holds: (/** @type {number} */ step) => holdsStep(shown, step),
    /** @param {number} step */
    show(step) {
      shown = step;
      published.set(step);
    },
  };
}

/**
 * One text node, projected with `scale` on its context (and `batch`, if
 * given), and what it is drawn with.
 *
 * @param {ReturnType<typeof handScale>} scale
 * @param {(container: THREE.Object3D) => TextBatch} [withBatch]
 * @param {UpdateChannel} [channel] The channel its effects run in, as a
 *   portal's do.
 */
function steppedRun(scale, withBatch, channel) {
  const restore = installRange();
  const element = document.createElement("span");
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
    const run = steppedRun(scale, undefined, channel);
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
    const run = steppedRun(scale, (container) => {
      panel = container;
      return createTextBatch(container);
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
