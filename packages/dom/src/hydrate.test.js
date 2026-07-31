import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { just, Signal, set, toObservable } from "@apendua.dev/signal";
import { userEvent } from "@testing-library/user-event";
import { $, children, keyedList, list } from "./dom.js";
import { text } from "./text.js";
import { className } from "./stylesheet.js";
import { on } from "./operators.js";
import { hydrate } from "./hydrate.js";

/**
 * Renders `build()` the way a server would, and returns the markup.
 *
 * @param {() => import("rxjs").Observable<import("./types.js").Mountable<Node>>} build
 * @returns {string}
 */
function renderToString(build) {
  const root = document.createElement("main");
  const subscription = just(root, [children(build())]).subscribe();
  const html = root.innerHTML;
  subscription.unsubscribe();
  return html;
}

/**
 * Creates a root holding server rendered markup.
 *
 * @param {string} html
 * @returns {Element}
 */
function serverRendered(html) {
  const root = document.createElement("main");
  root.innerHTML = html;
  return root;
}

/**
 * Records every node created while `fn` runs.
 *
 * @param {() => void} fn
 * @returns {{ elements: string[], texts: number }}
 */
function recordCreations(fn) {
  /** @type {string[]} */
  const elements = [];
  let texts = 0;
  const realCreateElement = document.createElement.bind(document);
  const realCreateTextNode = document.createTextNode.bind(document);
  document.createElement = /** @type {typeof document.createElement} */ (
    (/** @type {string} */ tag) => {
      elements.push(tag);
      return realCreateElement(tag);
    }
  );
  document.createTextNode = /** @type {typeof document.createTextNode} */ (
    (/** @type {string} */ value) => {
      texts += 1;
      return realCreateTextNode(value);
    }
  );
  try {
    fn();
  } finally {
    document.createElement = realCreateElement;
    document.createTextNode = realCreateTextNode;
  }
  return { elements, texts };
}

describe("hydrate()", () => {
  it("should adopt the server rendered nodes instead of creating new ones", () => {
    const html = renderToString(() => $("p", [children(text`hello`)]));
    const root = serverRendered(html);
    const original = root.querySelector("p");

    const created = recordCreations(() => {
      hydrate(root, $("p", [children(text`hello`)])).subscribe();
    });

    assert.deepEqual(created.elements, [], "expected no elements to be created");
    assert.strictEqual(created.texts, 0, "expected no text nodes to be created");
    assert.strictEqual(root.querySelector("p"), original, "expected the very same node");
    assert.strictEqual(root.querySelector("p")?.textContent, "hello");
  });

  it("should adopt a nested tree", () => {
    const build = () => {
      const span = $("span", [children(text`x`)]);
      const section = $("section", [children(span)]);
      return $("div", [children(section)]);
    };
    const root = serverRendered(renderToString(build));
    const div = root.querySelector("div");
    const span = root.querySelector("span");

    const created = recordCreations(() => {
      hydrate(root, build()).subscribe();
    });

    assert.deepEqual(created.elements, []);
    assert.strictEqual(root.querySelector("div"), div);
    assert.strictEqual(root.querySelector("span"), span);
  });

  it("should adopt several children of one parent", () => {
    const build = () => $("div", [children($("a"), $("b"), $("i"))]);
    const root = serverRendered(renderToString(build));
    const before = Array.from(root.querySelectorAll("div *"));

    const created = recordCreations(() => {
      hydrate(root, build()).subscribe();
    });

    assert.deepEqual(created.elements, []);
    assert.deepEqual(Array.from(root.querySelectorAll("div *")), before);
  });

  it("should attach event handlers to the adopted nodes", async () => {
    const handleClick = mock.fn();
    const root = serverRendered(renderToString(() => $("button", [children(text`go`)])));

    hydrate(root, $("button", [children(text`go`), on("click", handleClick)])).subscribe();

    const button = root.querySelector("button");
    assert.ok(button);
    await userEvent.click(button);
    assert.strictEqual(handleClick.mock.calls.length, 1);
  });

  it("should keep updating reactively after hydration", () => {
    const label = Signal.of("before");
    const root = serverRendered(renderToString(() => $("p", [children(text`before`)])));
    const paragraph = root.querySelector("p");

    hydrate(root, $("p", [children(text`${() => label.get()}`)])).subscribe();

    assert.strictEqual(paragraph?.textContent, "before");
    label.set("after");
    assert.strictEqual(paragraph?.textContent, "after", "expected the adopted node to update");
    assert.strictEqual(root.querySelector("p"), paragraph, "expected the node to be reused");
  });

  it("should apply operators that the markup cannot carry", () => {
    const root = serverRendered(renderToString(() => $("input")));
    const input = /** @type {HTMLInputElement | null} */ (root.querySelector("input"));

    hydrate(root, $("input", [set("value", just("typed"))])).subscribe();

    assert.strictEqual(input?.value, "typed");
  });

  it("should repair text that disagrees with the markup", () => {
    const root = serverRendered(renderToString(() => $("p", [children(text`stale`)])));
    const paragraph = root.querySelector("p");

    hydrate(root, $("p", [children(text`fresh`)])).subscribe();

    assert.strictEqual(paragraph?.textContent, "fresh");
    assert.strictEqual(root.querySelector("p"), paragraph, "expected a repair, not a rebuild");
  });

  it("should remove the adopted nodes when unsubscribed", () => {
    const root = serverRendered(renderToString(() => $("p", [children(text`bye`)])));

    const subscription = hydrate(root, $("p", [children(text`bye`)])).subscribe();
    assert.strictEqual(root.querySelectorAll("p").length, 1);

    subscription.unsubscribe();
    assert.strictEqual(root.querySelectorAll("p").length, 0);
  });

  it("should adopt the stylesheet the server injected", () => {
    const style = className`
      color: teal;
    `;
    // Server render: mount, capture both the markup and the injected styles.
    const server = document.createElement("main");
    const serverSubscription = just(server, [
      children($("p", [set("className", style), children(text`styled`)])),
    ]).subscribe();
    const markup = server.innerHTML;
    const head = document.head.innerHTML;
    serverSubscription.unsubscribe();

    // Re-create the document the browser would receive.
    document.head.innerHTML = head;
    const stylesFromServer = document.head.querySelectorAll("style").length;
    assert.strictEqual(stylesFromServer, 1);

    const root = serverRendered(markup);
    hydrate(root, $("p", [set("className", style), children(text`styled`)])).subscribe();

    assert.strictEqual(
      document.head.querySelectorAll("style").length,
      1,
      "expected the server stylesheet to be adopted, not duplicated",
    );
    document.head.innerHTML = "";
  });

  describe("lists", () => {
    /**
     * @param {string[]} values
     * @returns {import("rxjs").Observable<import("./types.js").Mountable<Node>>}
     */
    const buildList = (values) =>
      $("ul", [children(list(just(values), (item) => $("li", [children(text`${item}`)])))]);

    it("should adopt the items the server rendered", () => {
      const root = serverRendered(renderToString(() => buildList(["a", "b", "c"])));
      const before = Array.from(root.querySelectorAll("li"));

      const created = recordCreations(() => {
        hydrate(root, buildList(["a", "b", "c"])).subscribe();
      });

      assert.deepEqual(created.elements, [], "expected no elements to be created");
      assert.deepEqual(Array.from(root.querySelectorAll("li")), before, "expected the same nodes");
      assert.deepEqual(
        before.map((li) => li.textContent),
        ["a", "b", "c"],
      );
    });

    it("should keep the list reactive after adopting it", () => {
      const items = Signal.of(["a", "b"]);
      const build = () =>
        $("ul", [
          children(list(toObservable(items), (item) => $("li", [children(text`${item}`)]))),
        ]);
      const root = serverRendered(renderToString(build));
      const adopted = root.querySelector("li");

      hydrate(root, build()).subscribe();

      items.set(["a", "b", "c"]);
      assert.deepEqual(
        Array.from(root.querySelectorAll("li")).map((li) => li.textContent),
        ["a", "b", "c"],
        "expected an appended item",
      );
      assert.strictEqual(root.querySelector("li"), adopted, "expected the first node to survive");

      items.set(["b", "c"]);
      assert.deepEqual(
        Array.from(root.querySelectorAll("li")).map((li) => li.textContent),
        ["b", "c"],
        "expected a removed item",
      );
    });

    it("should adopt a keyed list", () => {
      /**
       * @param {Array<[string, string]>} entries
       */
      const build = (entries) =>
        $("ul", [
          children(keyedList(just(entries), (value) => $("li", [children(text`${value}`)]))),
        ]);
      const root = serverRendered(
        renderToString(() =>
          build([
            ["1", "one"],
            ["2", "two"],
          ]),
        ),
      );
      const before = Array.from(root.querySelectorAll("li"));

      const created = recordCreations(() => {
        hydrate(
          root,
          build([
            ["1", "one"],
            ["2", "two"],
          ]),
        ).subscribe();
      });

      assert.deepEqual(created.elements, []);
      assert.deepEqual(Array.from(root.querySelectorAll("li")), before);
    });

    it("should adopt items that render more than one node", () => {
      const build = () =>
        $("ul", [
          children(
            list(just(["a", "b"]), (item) =>
              $("li", [children($("span", [children(text`${item}`)]), $("i"))]),
            ),
          ),
        ]);
      const root = serverRendered(renderToString(build));
      const before = Array.from(root.querySelectorAll("li, span, i"));

      const created = recordCreations(() => {
        hydrate(root, build()).subscribe();
      });

      assert.deepEqual(created.elements, []);
      assert.deepEqual(Array.from(root.querySelectorAll("li, span, i")), before);
    });

    it("should remove an adopted list when unsubscribed", () => {
      const root = serverRendered(renderToString(() => buildList(["a", "b"])));

      const subscription = hydrate(root, buildList(["a", "b"])).subscribe();
      assert.strictEqual(root.querySelectorAll("li").length, 2);

      subscription.unsubscribe();
      assert.strictEqual(root.querySelectorAll("li").length, 0);
    });
  });

  describe("mismatches", () => {
    it("should rebuild when the tag does not match", () => {
      const root = serverRendered(renderToString(() => $("p", [children(text`hi`)])));
      const warn = mock.method(console, "warn", () => {});

      try {
        const created = recordCreations(() => {
          hydrate(root, $("section", [children(text`hi`)])).subscribe();
        });
        assert.deepEqual(created.elements, ["section"], "expected a fresh render");
      } finally {
        warn.mock.restore();
      }

      assert.strictEqual(warn.mock.calls.length, 1, "expected a warning");
      assert.strictEqual(root.querySelectorAll("p").length, 0, "expected the stale node to go");
      assert.strictEqual(root.querySelector("section")?.textContent, "hi");
    });

    it("should rebuild when the markup holds too few children", () => {
      const root = serverRendered(renderToString(() => $("div", [children($("a"))])));
      const warn = mock.method(console, "warn", () => {});

      try {
        hydrate(root, $("div", [children($("a"), $("b"))])).subscribe();
      } finally {
        warn.mock.restore();
      }

      assert.strictEqual(root.querySelectorAll("a").length, 1);
      assert.strictEqual(root.querySelectorAll("b").length, 1);
    });

    it("should rebuild when the markup holds too many children", () => {
      const root = serverRendered(renderToString(() => $("div", [children($("a"), $("b"))])));
      const warn = mock.method(console, "warn", () => {});

      try {
        hydrate(root, $("div", [children($("a"))])).subscribe();
      } finally {
        warn.mock.restore();
      }

      assert.strictEqual(root.querySelectorAll("b").length, 0, "expected the extra node to go");
      assert.strictEqual(root.querySelectorAll("a").length, 1);
    });

    it("should rebuild a list whose markup does not line up", () => {
      const build = (/** @type {string[]} */ values) =>
        $("ul", [children(list(just(values), (item) => $("li", [children(text`${item}`)])))]);
      const root = serverRendered(renderToString(() => build(["a", "b"])));
      const warn = mock.method(console, "warn", () => {});

      try {
        hydrate(root, build(["a", "b", "c"])).subscribe();
      } finally {
        warn.mock.restore();
      }

      assert.strictEqual(warn.mock.calls.length, 1, "expected a warning");
      assert.deepEqual(
        Array.from(root.querySelectorAll("li")).map((li) => li.textContent),
        ["a", "b", "c"],
      );
    });

    it("should leave hydration switched off for later mounts", () => {
      const failing = serverRendered(renderToString(() => $("p")));
      const warn = mock.method(console, "warn", () => {});
      try {
        hydrate(failing, $("section")).subscribe();
      } finally {
        warn.mock.restore();
      }

      // A perfectly good hydration after a failed one must still work.
      const root = serverRendered(renderToString(() => $("p", [children(text`ok`)])));
      const paragraph = root.querySelector("p");
      const created = recordCreations(() => {
        hydrate(root, $("p", [children(text`ok`)])).subscribe();
      });

      assert.deepEqual(created.elements, []);
      assert.strictEqual(root.querySelector("p"), paragraph);
    });

    it("should rebuild when the root is empty", () => {
      const root = document.createElement("main");
      const warn = mock.method(console, "warn", () => {});

      try {
        hydrate(root, $("p", [children(text`fresh`)])).subscribe();
      } finally {
        warn.mock.restore();
      }

      assert.strictEqual(root.querySelector("p")?.textContent, "fresh");
    });
  });

  it("should not adopt anything on a later render", () => {
    // Hydration only applies to the initial mount. A subtree rendered later, in
    // response to a signal, has no markup to adopt and must build its own.
    const which = Signal.of("a");
    const root = serverRendered(renderToString(() => $("p", [children(text`a`)])));

    hydrate(root, $("p", [children(text`${() => which.get()}`)])).subscribe();
    const paragraph = root.querySelector("p");

    which.set("b");
    assert.strictEqual(paragraph?.textContent, "b");
  });

  it("should hydrate svg elements", () => {
    const root = serverRendered(renderToString(() => $("div", [children(text`x`)])));
    const div = root.querySelector("div");

    hydrate(root, $("div", [children(text`x`)])).subscribe();

    assert.strictEqual(root.querySelector("div"), div);
  });
});
