import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Signal } from "justdom-signal";
import { branch, when } from "./core.js";
import { $, Nothing } from "./operators.js";

/**
 * Mounts one source under a group and names what the group then holds.
 *
 * @param {import("justdom-signal").Source<import("./core.js").Component>} source
 * @returns {{ parent: THREE.Group, names: () => string[], dispose: () => void }}
 */
function mount(source) {
  const parent = new THREE.Group();
  /** @type {(() => void) | undefined} */
  let remove;
  const subscription = source.subscribe((component) => {
    remove = component.addTo(parent);
  });
  return {
    parent,
    names: () => parent.children.map((child) => child.name),
    dispose: () => {
      remove?.();
      subscription.unsubscribe();
    },
  };
}

/**
 * @param {string} name
 */
function named(name) {
  const object = new THREE.Object3D();
  object.name = name;
  return $(object);
}

describe("when()", () => {
  test("mounts what it renders while the condition holds", () => {
    const shown = Signal.of(false);
    const mounted = mount(
      when(
        () => shown.get(),
        () => named("palette"),
      ),
    );
    assert.deepStrictEqual(mounted.names(), []);

    shown.set(true);
    assert.deepStrictEqual(mounted.names(), ["palette"]);

    shown.set(false);
    assert.deepStrictEqual(mounted.names(), []);
    mounted.dispose();
  });

  test("leaves what is mounted alone while the condition still holds", () => {
    const count = Signal.of(1);
    let rendered = 0;
    const mounted = mount(
      when(
        () => count.get(),
        () => {
          rendered += 1;
          return named("palette");
        },
      ),
    );
    const object = mounted.parent.children[0];

    // Another truthy value: the condition is read again and holds as before.
    count.set(2);
    assert.strictEqual(rendered, 1);
    assert.strictEqual(mounted.parent.children[0], object);
    mounted.dispose();
  });

  test("renders afresh each time the condition comes to hold", () => {
    const shown = Signal.of(true);
    let rendered = 0;
    const mounted = mount(
      when(
        () => shown.get(),
        () => {
          rendered += 1;
          return named("palette");
        },
      ),
    );
    const first = mounted.parent.children[0];

    shown.set(false);
    shown.set(true);
    assert.strictEqual(rendered, 2);
    assert.notStrictEqual(mounted.parent.children[0], first, "a new object, not the old one");
    mounted.dispose();
  });

  test("takes what it mounted out when the mounting comes down", () => {
    const mounted = mount(
      when(
        () => true,
        () => named("palette"),
      ),
    );
    assert.deepStrictEqual(mounted.names(), ["palette"]);
    mounted.dispose();
    assert.deepStrictEqual(mounted.names(), []);
  });
});

describe("branch()", () => {
  test("mounts the alternative of the key, and another when the key changes", () => {
    const phase = Signal.of("build");
    /** @type {string[]} */
    const rendered = [];
    const mounted = mount(
      branch(
        () => phase.get(),
        (key) => {
          rendered.push(key);
          return named(key);
        },
      ),
    );
    assert.deepStrictEqual(mounted.names(), ["build"]);

    phase.set("siege");
    assert.deepStrictEqual(mounted.names(), ["siege"]);
    assert.deepStrictEqual(rendered, ["build", "siege"]);
    mounted.dispose();
  });

  test("keeps the alternative that is mounted while the key stays the same", () => {
    const brick = Signal.of({ type: "arch", turns: 0 });
    let rendered = 0;
    const mounted = mount(
      branch(
        () => brick.get().type,
        (type) => {
          rendered += 1;
          return named(type);
        },
      ),
    );
    const object = mounted.parent.children[0];

    brick.set({ type: "arch", turns: 1 });
    assert.strictEqual(rendered, 1);
    assert.strictEqual(mounted.parent.children[0], object);

    brick.set({ type: "wall", turns: 0 });
    assert.strictEqual(rendered, 2);
    assert.deepStrictEqual(mounted.names(), ["wall"]);
    mounted.dispose();
  });

  test("shows nothing for an alternative that is Nothing()", () => {
    /** @type {Signal<string | undefined>} */
    const type = Signal.of(undefined);
    const mounted = mount(
      branch(
        () => type.get(),
        (key) => (key ? named(key) : Nothing()),
      ),
    );
    assert.deepStrictEqual(mounted.names(), []);

    type.set("arch");
    assert.deepStrictEqual(mounted.names(), ["arch"]);

    type.set(undefined);
    assert.deepStrictEqual(mounted.names(), []);
    mounted.dispose();
  });
});
