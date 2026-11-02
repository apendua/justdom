import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Signal, just, toObservable } from "justdom-signal";
import { className, fontFace, stylesheet } from "./stylesheet.js";

/**
 * Subscribes to a name observable and reports the emitted name together with
 * the css that was injected into the document head while it was subscribed.
 *
 * @param {import("justdom-signal").Subscribable<string>} name$
 * @returns {{ name: string, css: string, unsubscribe: () => void }}
 */
function mount(name$) {
  /** @type {string} */
  let name = "";
  const subscription = name$.subscribe({
    next: (value) => {
      name = value;
    },
  });
  return {
    get name() {
      return name;
    },
    get css() {
      return Array.from(document.head.querySelectorAll("style"))
        .map((element) => element.innerHTML)
        .join("\n");
    },
    unsubscribe: () => subscription.unsubscribe(),
  };
}

describe("className()", () => {
  it("should keep the same name across subscriptions", () => {
    const style = className`
      color: red;
    `;

    const first = mount(style);
    const nameWhileMounted = first.name;
    first.unsubscribe();

    const second = mount(style);
    assert.strictEqual(second.name, nameWhileMounted);
    second.unsubscribe();
  });

  it("should derive the same name in a separate evaluation of the same source", () => {
    // Two call sites with byte-identical static parts stand in for the same
    // template being evaluated by a server and by a client.
    const onServer = className`
      color: blue;
    `;
    const onClient = className`
      color: blue;
    `;

    const server = mount(onServer);
    const client = mount(onClient);
    assert.strictEqual(server.name, client.name);
    server.unsubscribe();
    client.unsubscribe();
  });

  it("should keep the name stable while an interpolated value changes", () => {
    const color = Signal.of("red");
    const style = className`
      color: ${toObservable(color)};
    `;

    const mounted = mount(style);
    const before = mounted.name;
    assert.match(mounted.css, /color: red;/);

    color.set("green");
    assert.match(mounted.css, /color: green;/, "expected the css to be rewritten");
    assert.strictEqual(mounted.name, before, "expected the class name to stay put");

    mounted.unsubscribe();
  });

  it("should not collide when two call sites share their static parts", () => {
    // Same static parts, different interpolations: these must not share a name,
    // or they would overwrite each other's rule.
    const first = className`
      color: ${just("red")};
    `;
    const second = className`
      color: ${just("blue")};
    `;

    const a = mount(first);
    const b = mount(second);

    assert.notStrictEqual(a.name, b.name);
    assert.match(a.css, /color: red;/);
    assert.match(a.css, /color: blue;/);

    a.unsubscribe();
    b.unsubscribe();
  });

  it("should remove the style element on teardown", () => {
    const style = className`
      color: hotpink;
    `;

    const mounted = mount(style);
    assert.match(mounted.css, /hotpink/);
    mounted.unsubscribe();

    assert.doesNotMatch(document.head.innerHTML, /hotpink/);
  });
});

describe("stylesheet()", () => {
  it("should keep the same name across subscriptions", () => {
    const style = stylesheet`
      .nested {
        color: teal;
      }
    `;

    const first = mount(style);
    const nameWhileMounted = first.name;
    first.unsubscribe();

    const second = mount(style);
    assert.strictEqual(second.name, nameWhileMounted);
    second.unsubscribe();
  });
});

describe("fontFace()", () => {
  it("should derive the same name from the same inputs", () => {
    const first = mount(fontFace("/fonts/example.ttf"));
    const second = mount(fontFace("/fonts/example.ttf"));

    assert.strictEqual(first.name, second.name);
    first.unsubscribe();
    second.unsubscribe();
  });

  it("should derive different names for different inputs", () => {
    const first = mount(fontFace("/fonts/example.ttf"));
    const second = mount(fontFace("/fonts/other.ttf"));

    assert.notStrictEqual(first.name, second.name);
    first.unsubscribe();
    second.unsubscribe();
  });
});
