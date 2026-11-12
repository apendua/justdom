import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { just, onCleanup, Signal, Stream } from "justdom-signal";
import { $, $$, branch, children, list, Nothing, toMountable, when } from "./dom.js";
import { replaceSegment } from "./helpers.js";
import { countDomCalls } from "./test/domCalls.js";
import { text } from "./text.js";

/**
 * @param {Element} root
 * @returns {string}
 */
function markup(root) {
  return root.innerHTML.replace(/<!---->/g, "");
}

/**
 * Records the tag of every element created while `fn` runs. `fn` receives the
 * untouched `createElement` for building scaffolding that should not be
 * recorded, plus the live list of tags recorded so far.
 *
 * @param {(createElement: (tag: string) => Element, created: string[]) => void} fn
 * @returns {string[]}
 */
function recordCreatedElements(fn) {
  /** @type {string[]} */
  const created = [];
  const realCreateElement = document.createElement.bind(document);
  document.createElement = /** @type {typeof document.createElement} */ (
    (/** @type {string} */ tag) => {
      created.push(tag);
      return realCreateElement(tag);
    }
  );
  try {
    fn(realCreateElement, created);
  } finally {
    document.createElement = realCreateElement;
  }
  return created;
}

describe("$()", () => {
  it("should not create the element before it is subscribed to", () => {
    const created = recordCreatedElements((createElement, recorded) => {
      const element = $("section");
      assert.deepEqual(recorded, [], "expected nothing to be created yet");

      const root = createElement("main");
      just(root, [children(element)]).subscribe();
    });

    assert.deepEqual(created, ["section"]);
  });

  it("should acquire elements in document order", () => {
    const created = recordCreatedElements((createElement) => {
      const tree = $("div", [children($("section", [children($("span"))]))]);

      const root = createElement("main");
      just(root, [children(tree)]).subscribe();
    });

    // Outermost first. Argument evaluation alone would give the reverse.
    assert.deepEqual(created, ["div", "section", "span"]);
  });

  it("should give every subscriber its own element", () => {
    const shared = $("span", [children(text`shared`)]);

    const root = document.createElement("main");
    just(root, [children(shared, shared)]).subscribe();

    assert.strictEqual(root.querySelectorAll("span").length, 2);
    assert.strictEqual(markup(root), "<span>shared</span><span>shared</span>");
  });

  it("should still render a plain element", () => {
    const root = document.createElement("main");
    just(root, [children($("p", [children(text`hello`)]))]).subscribe();

    assert.strictEqual(markup(root), "<p>hello</p>");
  });
});

describe("$$()", () => {
  it("should create svg elements lazily, in their own namespace", () => {
    const element = $$("circle");

    const root = document.createElement("main");
    just(root, [children(element)]).subscribe();

    const circle = root.querySelector("circle");
    assert.ok(circle);
    assert.strictEqual(circle.namespaceURI, "http://www.w3.org/2000/svg");
  });

  it("should give every subscriber its own element", () => {
    const shared = $$("circle");

    const root = document.createElement("main");
    just(root, [children(shared, shared)]).subscribe();

    assert.strictEqual(root.querySelectorAll("circle").length, 2);
  });
});

describe("children()", () => {
  it("reports a child's failure, now or later, to whoever mounted the element", () => {
    const failure = new Error("child failed");
    /** @type {((err: Error) => void) | undefined} */
    let failLater;
    const later = new Stream((subscriber) => {
      failLater = (err) => subscriber.error(err);
    });

    /** @type {unknown[]} */
    const heardNow = [];
    just(document.createElement("div"), [
      children(new Stream((subscriber) => subscriber.error(failure))),
    ]).subscribe({ error: (err) => heardNow.push(err) });
    assert.deepStrictEqual(heardNow, [failure], "a child failing as it is mounted");

    /** @type {unknown[]} */
    const heardLater = [];
    just(document.createElement("div"), [children($("span"), later)]).subscribe({
      error: (err) => heardLater.push(err),
    });
    assert.deepStrictEqual(heardLater, []);
    failLater?.(failure);
    assert.deepStrictEqual(heardLater, [failure], "a child failing once it is mounted");
  });

  it("mounts straight into an empty element, one insertion per node and no comment", () => {
    const tree = $("tr", [
      children($("td", [children($("a", [children($("span"))]))]), $("td"), text`end`),
    ]);
    const root = document.createElement("table");

    const calls = countDomCalls(() => {
      just(root, [children(tree)]).subscribe();
    });

    assert.equal(root.innerHTML, "<tr><td><a><span></span></a></td><td></td>end</tr>");
    assert.deepEqual(calls, {
      createElement: 5,
      createComment: 0,
      createTextNode: 1,
      createDocumentFragment: 0,
      insertBefore: 6,
      appendChild: 0,
      replaceChild: 0,
      removeChild: 0,
    });
  });

  it("holds the place of a child that arrives late, between its siblings", () => {
    /** @type {(() => void) | undefined} */
    let arrive;
    const late = new Stream((subscriber) => {
      arrive = () => subscriber.next(toMountable(document.createElement("section")));
    });
    const root = document.createElement("main");
    just(root, [children($("header"), late, $("footer"))]).subscribe();
    assert.equal(root.innerHTML, "<header></header><!----><footer></footer>");

    arrive?.();

    assert.equal(root.innerHTML, "<header></header><section></section><footer></footer>");
  });

  it("mounts a child that can only replace, through a placeholder", () => {
    const node = document.createElement("section");
    const foreign = just({
      /** @param {[Node, Node]} segment */
      replace: (segment) => replaceSegment([node, node], segment),
    });
    const root = document.createElement("main");

    just(root, [children($("header"), foreign, $("footer"))]).subscribe();

    assert.equal(root.innerHTML, "<header></header><section></section><footer></footer>");
  });

  it("keeps the two comments around a list, and inserts each item once", () => {
    const items = Signal.of(["a", "b", "c"]);
    const root = document.createElement("ul");

    const calls = countDomCalls(() => {
      just(root, [
        children(
          list(
            () => items.get(),
            () => $("li"),
          ),
        ),
      ]).subscribe();
    });

    assert.equal(root.innerHTML, "<!----><li></li><li></li><li></li><!---->");
    assert.equal(calls.createComment, 2);
    assert.equal(calls.replaceChild, 0);
    // The three items into the list's fragment, and the fragment into the
    // element.
    assert.equal(calls.insertBefore, 4);

    const added = countDomCalls(() => items.set(["a", "x", "b", "c"]));

    assert.equal(root.innerHTML, "<!----><li></li><li></li><li></li><li></li><!---->");
    assert.deepEqual(
      { ...added, createElement: 0 },
      {
        createElement: 0,
        createComment: 0,
        createTextNode: 0,
        createDocumentFragment: 0,
        insertBefore: 1,
        appendChild: 0,
        replaceChild: 0,
        removeChild: 0,
      },
    );
  });

  it("replaces what an element already held", () => {
    const root = document.createElement("main");
    root.innerHTML = "<p>old</p>text";

    just(root, [children($("header"), $("footer"))]).subscribe();

    assert.equal(markup(root), "<header></header><footer></footer>");
  });

  it("takes its children out, and lets go of them, when the mounting comes down", () => {
    let unsubscribed = 0;
    const child = new Stream(() => () => {
      unsubscribed += 1;
    });
    const root = document.createElement("main");
    const subscription = just(root, [children($("span"), child)]).subscribe();
    assert.strictEqual(root.querySelectorAll("span").length, 1);

    subscription.unsubscribe();
    assert.strictEqual(root.querySelectorAll("span").length, 0);
    assert.strictEqual(unsubscribed, 1);
  });
});

describe("when()", () => {
  it("mounts what it renders while the condition holds, between its siblings", () => {
    const shown = Signal.of(false);
    const root = document.createElement("main");
    just(root, [
      children(
        $("header"),
        when(
          () => shown.get(),
          () => $("p"),
        ),
        $("footer"),
      ),
    ]).subscribe();
    assert.strictEqual(markup(root), "<header></header><footer></footer>");

    shown.set(true);
    assert.strictEqual(markup(root), "<header></header><p></p><footer></footer>");

    shown.set(false);
    assert.strictEqual(markup(root), "<header></header><footer></footer>");
  });

  it("leaves what is mounted alone while the condition still holds", () => {
    const count = Signal.of(1);
    let rendered = 0;
    const root = document.createElement("main");
    just(root, [
      children(
        when(
          () => count.get(),
          () => {
            rendered += 1;
            return $("p");
          },
        ),
      ),
    ]).subscribe();
    const mounted = root.querySelector("p");

    // Another truthy value: the condition is read again and holds as before.
    count.set(2);
    assert.strictEqual(rendered, 1);
    assert.strictEqual(root.querySelector("p"), mounted);
  });

  it("renders afresh each time the condition comes to hold", () => {
    const shown = Signal.of(true);
    let rendered = 0;
    const root = document.createElement("main");
    just(root, [
      children(
        when(
          () => shown.get(),
          () => {
            rendered += 1;
            return $("input");
          },
        ),
      ),
    ]).subscribe();
    const first = root.querySelector("input");

    shown.set(false);
    shown.set(true);
    assert.strictEqual(rendered, 2);
    assert.notStrictEqual(root.querySelector("input"), first, "a new element, not the old one");
  });
});

describe("branch()", () => {
  it("mounts the alternative of the key, and another when the key changes", () => {
    const state = Signal.of("waiting");
    /** @type {string[]} */
    const rendered = [];
    const root = document.createElement("main");
    just(root, [
      children(
        $("header"),
        branch(
          () => state.get(),
          (key) => {
            rendered.push(key);
            return key === "waiting" ? $("progress") : $("p");
          },
        ),
      ),
    ]).subscribe();
    assert.strictEqual(markup(root), "<header></header><progress></progress>");

    state.set("ready");
    assert.strictEqual(markup(root), "<header></header><p></p>");
    assert.deepStrictEqual(rendered, ["waiting", "ready"]);
  });

  it("keeps the alternative that is mounted while the key stays the same", () => {
    const game = Signal.of({ id: "a", moves: 0 });
    let rendered = 0;
    const root = document.createElement("main");
    just(root, [
      children(
        branch(
          () => game.get().id,
          () => {
            rendered += 1;
            return $("section");
          },
        ),
      ),
    ]).subscribe();
    const mounted = root.querySelector("section");

    game.set({ id: "a", moves: 1 });
    assert.strictEqual(rendered, 1);
    assert.strictEqual(root.querySelector("section"), mounted);

    game.set({ id: "b", moves: 0 });
    assert.strictEqual(rendered, 2);
    assert.notStrictEqual(root.querySelector("section"), mounted);
  });

  it("shows nothing for an alternative that is Nothing()", () => {
    const state = Signal.of("empty");
    const root = document.createElement("main");
    just(root, [
      children(
        $("header"),
        branch(
          () => state.get(),
          (key) => (key === "empty" ? Nothing() : $("p")),
        ),
        $("footer"),
      ),
    ]).subscribe();
    assert.strictEqual(markup(root), "<header></header><footer></footer>");

    state.set("full");
    assert.strictEqual(markup(root), "<header></header><p></p><footer></footer>");

    state.set("empty");
    assert.strictEqual(markup(root), "<header></header><footer></footer>");
  });
});

describe("Nothing()", () => {
  it("puts no element in the document", () => {
    const root = document.createElement("main");
    just(root, [children($("header"), Nothing(), $("footer"))]).subscribe();
    assert.strictEqual(markup(root), "<header></header><footer></footer>");
    assert.strictEqual(root.children.length, 2);
  });
});

describe("unmounting", () => {
  /**
   * A table row of five elements, three levels deep, that reports when the
   * innermost one is let go of.
   *
   * @param {string[]} released
   * @param {string} name
   */
  const Row = (released, name) =>
    $("tr", [
      children(
        $("td", [
          children($("a", [children($("span", [() => onCleanup(() => released.push(name))]))])),
        ]),
        $("td"),
      ),
    ]);

  it("takes an item that left a list out with one removal, however deep it is", () => {
    const items = Signal.of(["a", "b", "c"]);
    /** @type {string[]} */
    const released = [];
    const root = document.createElement("table");
    just(root, [
      children(
        list(
          () => items.get(),
          (name) => Row(released, name),
        ),
      ),
    ]).subscribe();
    assert.equal(root.querySelectorAll("tr").length, 3);

    const calls = countDomCalls(() => items.set(["a", "c"]));

    assert.equal(calls.removeChild, 1);
    assert.equal(root.querySelectorAll("tr").length, 2);
    assert.deepEqual(released, ["b"]);
  });

  it("takes one removal per item to empty a list", () => {
    const items = Signal.of(["a", "b", "c"]);
    /** @type {string[]} */
    const released = [];
    const root = document.createElement("table");
    just(root, [
      children(
        list(
          () => items.get(),
          (name) => Row(released, name),
        ),
      ),
    ]).subscribe();

    const calls = countDomCalls(() => items.set([]));

    assert.equal(calls.removeChild, 3);
    assert.equal(root.querySelectorAll("tr").length, 0);
    assert.deepEqual(released.sort(), ["a", "b", "c"]);
  });

  it("removes each child of the element whose mounting ends, and nothing below it", () => {
    /** @type {string[]} */
    const released = [];
    const root = document.createElement("table");
    const mounting = just(root, [
      children(Row(released, "first"), Row(released, "second")),
    ]).subscribe();

    const calls = countDomCalls(() => mounting.unsubscribe());

    assert.equal(calls.removeChild, 2);
    assert.equal(markup(root), "");
    assert.deepEqual(released, ["first", "second"]);
  });

  it("still removes what a leaving subtree mounted somewhere else", () => {
    const shown = Signal.of(true);
    const elsewhere = document.createElement("aside");
    const root = document.createElement("main");
    const dialog = just(elsewhere, [children($("dialog", [children($("p"))]))]);
    just(root, [
      children(
        when(
          () => shown.get(),
          () =>
            $("section", [
              () => {
                const mounted = dialog.subscribe();
                onCleanup(() => mounted.unsubscribe());
              },
            ]),
        ),
      ),
    ]).subscribe();
    assert.equal(markup(elsewhere), "<dialog><p></p></dialog>");

    const calls = countDomCalls(() => shown.set(false));

    assert.equal(markup(elsewhere), "");
    assert.equal(markup(root), "");
    // The section, and the dialog it had put in the other element.
    assert.equal(calls.removeChild, 2);
  });
});
