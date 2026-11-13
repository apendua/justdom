import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import fc from "fast-check";
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

describe("what a mounted element keeps", () => {
  it("lets go of the sources that described its children", async () => {
    setFlagsFromString("--expose-gc");
    const collect = /** @type {() => void} */ (runInNewContext("gc"));
    const root = document.createElement("main");
    /** @type {WeakRef<object>[]} */
    const described = [];
    // The item of a list, since its sources are made while the list renders
    // and nothing outside the list ever holds them.
    const Item = () => {
      const grandchild = $("b", [(b) => void (b.textContent = "deep")]);
      const child = $("span", [children(grandchild)]);
      described.push(new WeakRef(child), new WeakRef(grandchild));
      return $("p", [children(child)]);
    };
    const subscription = just(root, [children(list(() => [1], Item))]).subscribe();
    assert.strictEqual(markup(root), "<p><span><b>deep</b></span></p>");

    // A `WeakRef` keeps its target until the job that made it has ended.
    await new Promise((resolve) => setImmediate(resolve));
    collect();
    assert.deepStrictEqual(
      described.map((source) => source.deref()),
      [undefined, undefined],
    );

    // What was mounted does not need them to come down again.
    subscription.unsubscribe();
    assert.strictEqual(markup(root), "");
  });
});

describe("an element as a child", () => {
  /**
   * Counts the subscriptions `source` is given from here on.
   *
   * @param {import("justdom-signal").Subscribable<unknown>} source
   * @returns {() => number}
   */
  function countSubscriptions(source) {
    let count = 0;
    const subscribe = source.subscribe.bind(source);
    source.subscribe = /** @type {typeof source.subscribe} */ (
      (subscriber) => {
        count += 1;
        return subscribe(subscriber);
      }
    );
    return () => count;
  }

  it("is mounted by its parent without a subscription, built before it goes in", () => {
    /** @type {string[]} */
    const log = [];
    const child = $("span", [
      (span) => {
        log.push(span.parentNode ? "in the tree" : "loose");
        span.textContent = "hello";
        onCleanup(() => log.push("let go"));
      },
    ]);
    const subscriptions = countSubscriptions(child);
    const root = document.createElement("main");

    const mounted = just(root, [children(child, child)]).subscribe();

    assert.strictEqual(subscriptions(), 0);
    assert.strictEqual(markup(root), "<span>hello</span><span>hello</span>");
    assert.deepStrictEqual(log, ["loose", "loose"]);

    mounted.unsubscribe();
    assert.strictEqual(markup(root), "");
    assert.deepStrictEqual(log, ["loose", "loose", "let go", "let go"]);
  });

  it("is mounted by a list without a subscription, and leaves with one removal", () => {
    const items = Signal.of(["a", "b"]);
    /** @type {string[]} */
    const released = [];
    /** @type {Array<() => number>} */
    const subscriptions = [];
    const root = document.createElement("ul");
    just(root, [
      children(
        list(
          () => items.get(),
          (name) => {
            const item = $("li", [
              children($("b")),
              (li) => {
                li.title = name;
                onCleanup(() => released.push(name));
              },
            ]);
            subscriptions.push(countSubscriptions(item));
            return item;
          },
        ),
      ),
    ]).subscribe();
    items.set(["c", "a", "b"]);

    assert.deepStrictEqual(
      subscriptions.map((count) => count()),
      [0, 0, 0],
    );
    assert.strictEqual(
      markup(root),
      '<li title="c"><b></b></li><li title="a"><b></b></li><li title="b"><b></b></li>',
    );

    const calls = countDomCalls(() => items.set(["c", "b"]));
    assert.strictEqual(calls.removeChild, 1);
    assert.strictEqual(markup(root), '<li title="c"><b></b></li><li title="b"><b></b></li>');
    assert.deepStrictEqual(released, ["a"]);

    items.set([]);
    assert.strictEqual(markup(root), "");
    assert.deepStrictEqual(released.sort(), ["a", "b", "c"]);
  });

  it("fails its parent when an effect throws on the way in, and mounts no child after it", () => {
    const failure = new Error("on the way in");
    /** @type {string[]} */
    const log = [];
    /** @type {unknown[]} */
    const errors = [];
    const root = document.createElement("main");
    just(root, [
      children(
        $("i", [() => onCleanup(() => log.push("first let go"))]),
        $("b", [
          () => onCleanup(() => log.push("second let go")),
          () => {
            throw failure;
          },
        ]),
        $("u", [() => log.push("third mounted")]),
      ),
    ]).subscribe({ error: (err) => errors.push(err) });

    assert.deepStrictEqual(errors, [failure]);
    assert.deepStrictEqual(log, ["second let go", "first let go"]);
    assert.strictEqual(markup(root), "");
  });

  it("fails its parent when an effect fails later, and comes down with it", () => {
    const broken = Signal.of(false);
    /** @type {string[]} */
    const log = [];
    /** @type {unknown[]} */
    const errors = [];
    const root = document.createElement("main");
    just(root, [
      children(
        $("i", [() => onCleanup(() => log.push("sibling let go"))]),
        $("b", [
          () => {
            if (broken.get()) {
              throw new Error("later");
            }
          },
          () => onCleanup(() => log.push("let go")),
        ]),
      ),
    ]).subscribe({ error: (err) => errors.push(err) });
    assert.strictEqual(markup(root), "<i></i><b></b>");

    broken.set(true);

    assert.strictEqual(errors.length, 1);
    assert.match(String(errors[0]), /later/);
    assert.deepStrictEqual(log, ["sibling let go", "let go"]);
    assert.strictEqual(markup(root), "");
  });

  it("fails the list when an item's effect throws on the way in", () => {
    const items = Signal.of(["a"]);
    /** @type {string[]} */
    const released = [];
    /** @type {unknown[]} */
    const errors = [];
    const root = document.createElement("ul");
    const render = (/** @type {string} */ name) =>
      $("li", [
        () => onCleanup(() => released.push(name)),
        () => {
          if (name === "bad") {
            throw new Error(`${name} failed`);
          }
        },
      ]);
    just(root, [children(list(() => items.get(), render))]).subscribe({
      error: (err) => errors.push(err),
    });
    assert.strictEqual(markup(root), "<li></li>");

    items.set(["a", "bad"]);
    assert.match(String(errors[0]), /bad failed/);
    assert.deepStrictEqual(released.sort(), ["a", "bad"]);
    assert.strictEqual(markup(root), "");
  });

  it("fails the list when an item's effect fails later", () => {
    const broken = Signal.of(false);
    /** @type {unknown[]} */
    const errors = [];
    const root = document.createElement("ul");
    const placeholder = root.appendChild(document.createComment(""));
    // Subscribed to directly, so that nothing above the list takes the
    // nodes out while the list is closing.
    list(
      () => ["a"],
      () =>
        $("li", [
          () => {
            if (broken.get()) {
              throw new Error("later");
            }
          },
        ]),
    ).subscribe({
      next: (mountable) => {
        mountable.replace([placeholder, placeholder]);
      },
      error: (err) => errors.push(err),
    });
    assert.strictEqual(markup(root), "<li></li>");

    broken.set(true);

    assert.strictEqual(errors.length, 1);
    assert.match(String(errors[0]), /later/);
    assert.strictEqual(markup(root), "");
  });

  it("cannot fail the list, or the parent, it has left", () => {
    const items = Signal.of(["a", "b"]);
    const shown = Signal.of(true);
    /** @type {Record<string, (err: unknown) => void>} */
    const fails = {};
    /** @type {unknown[]} */
    const errors = [];
    const root = document.createElement("main");
    /** @param {string} name */
    const reporting = (name) =>
      $("i", [
        (_, { fail }) => {
          fails[name] = fail;
        },
      ]);
    just(root, [
      children(
        list(() => items.get(), reporting),
        when(
          () => shown.get(),
          () => $("p", [children(reporting("inner"))]),
        ),
      ),
    ]).subscribe({ error: (err) => errors.push(err) });
    assert.strictEqual(markup(root), "<i></i><i></i><p><i></i></p>");

    items.set(["b"]);
    shown.set(false);
    fails.a(new Error("late from a"));
    fails.inner(new Error("late from inner"));

    assert.deepStrictEqual(errors, []);
    assert.strictEqual(markup(root), "<i></i>");
  });

  it("answers a subscriber with its mountable, and with its failures", () => {
    const broken = Signal.of(false);
    /** @type {string[]} */
    const log = [];
    /** @type {unknown[]} */
    const errors = [];
    const element = $("p", [
      (p) => {
        p.textContent = "subscribed";
        onCleanup(() => log.push("let go"));
      },
      () => {
        if (broken.get()) {
          throw new Error("later");
        }
      },
    ]);
    const root = document.createElement("main");
    const first = root.appendChild(document.createComment(""));
    const second = root.appendChild(document.createComment(""));
    /** @param {Comment} placeholder */
    const subscribe = (placeholder) =>
      element.subscribe({
        next: (mountable) => {
          mountable.replace([placeholder, placeholder]);
        },
        error: (err) => errors.push(err),
      });

    const subscription = subscribe(first);
    assert.strictEqual(markup(root), "<p>subscribed</p>");
    subscription.unsubscribe();
    assert.deepStrictEqual(log, ["let go"]);

    subscribe(second);
    broken.set(true);
    assert.strictEqual(errors.length, 1);
    assert.match(String(errors[0]), /later/);
    assert.deepStrictEqual(log, ["let go", "let go"]);

    $("p", [
      () => {
        throw new Error("on the way in");
      },
    ]).subscribe({ error: (err) => errors.push(err) });
    assert.match(String(errors[1]), /on the way in/);
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

  it("fails the mounting when a child cannot be placed, and mounts no child after it", () => {
    const broken = just({
      replace: () => {
        throw new Error("cannot be placed");
      },
    });
    /** @type {unknown[]} */
    const errors = [];
    /** @type {string[]} */
    const created = [];
    const root = document.createElement("main");

    just(root, [
      children(
        $("header"),
        /** @type {import("justdom-signal").Subscribable<import("./types.js").Mountable>} */ (
          broken
        ),
        $("footer", [() => created.push("footer")]),
      ),
    ]).subscribe({ error: (error) => errors.push(error) });

    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /cannot be placed/);
    assert.deepEqual(created, []);
    assert.equal(markup(root), "");
  });

  it("holds the place of a list item that arrives late, and lets it leave", () => {
    const items = Signal.of(["a", "c"]);
    /** @type {Map<string, () => void>} */
    const arrive = new Map();
    const root = document.createElement("ul");
    just(root, [
      children(
        list(
          () => items.get(),
          (name) =>
            name === "b"
              ? new Stream((subscriber) => {
                  arrive.set(name, () => subscriber.next(toMountable(document.createElement("b"))));
                })
              : $("li"),
        ),
      ),
    ]).subscribe();

    items.set(["a", "b", "c"]);
    assert.equal(root.innerHTML, "<!----><li></li><!----><li></li><!---->");

    arrive.get("b")?.();
    assert.equal(root.innerHTML, "<!----><li></li><b></b><li></li><!---->");

    items.set(["a", "c"]);
    assert.equal(root.innerHTML, "<!----><li></li><li></li><!---->");
  });

  it("moves a list that is mounted a second time, with its comments and in order", () => {
    /** @type {import("./types.js").Mountable | undefined} */
    let mountable;
    list(
      () => ["a", "b"],
      (name) => $(name === "a" ? "i" : "b"),
    ).subscribe({ next: (value) => (mountable = value) });
    assert.ok(mountable);
    const first = document.createElement("p");
    const second = document.createElement("p");

    just(first, [children(just(mountable))]).subscribe();
    assert.equal(first.innerHTML, "<!----><i></i><b></b><!---->");

    just(second, [children(just(mountable))]).subscribe();
    assert.equal(first.innerHTML, "");
    assert.equal(second.innerHTML, "<!----><i></i><b></b><!---->");
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

  it("removes an item with one removal when the item holds a list of its own", () => {
    const items = Signal.of(["a", "b"]);
    const root = document.createElement("table");
    just(root, [
      children(
        list(
          () => items.get(),
          () =>
            $("tr", [
              children(
                list(
                  () => ["x", "y", "z"],
                  () => $("td"),
                ),
              ),
            ]),
        ),
      ),
    ]).subscribe();
    assert.equal(root.querySelectorAll("td").length, 6);

    const calls = countDomCalls(() => items.set(["a"]));

    // The inner list's segment is longer than one node, so it cannot be
    // named as leaving, and the row above it has to stay named.
    assert.equal(calls.removeChild, 1);
    assert.equal(root.querySelectorAll("td").length, 3);
  });

  it("removes the nodes of a child whose cleanup throws", () => {
    const root = document.createElement("div");
    const mounting = just(root, [
      children(
        $("p", [
          () =>
            onCleanup(() => {
              throw new Error("boom");
            }),
        ]),
        $("b"),
      ),
    ]).subscribe();
    assert.equal(markup(root), "<p></p><b></b>");

    assert.throws(() => mounting.unsubscribe(), /boom/);

    assert.equal(markup(root), "");
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

describe("a list item of several nodes", () => {
  /**
   * An item that is a list of its own: two elements between two comments.
   *
   * @param {string[]} released
   * @param {string} name
   */
  const Pair = (released, name) =>
    list(
      () => [1, 2],
      (n) =>
        $("b", [
          (b) => {
            b.textContent = `${name}${n}`;
            onCleanup(() => released.push(`${name}${n}`));
          },
        ]),
    );

  /**
   * @param {string[]} names
   */
  const pairs = (names) => names.map((name) => `<b>${name}1</b><b>${name}2</b>`).join("");

  /**
   * @param {string[]} initial
   */
  function mountPairs(initial) {
    const items = Signal.of(initial);
    /** @type {string[]} */
    const released = [];
    /** @type {unknown[]} */
    const errors = [];
    const root = document.createElement("main");
    const mounted = just(root, [
      children(
        list(
          () => items.get(),
          (name) => Pair(released, name),
        ),
      ),
    ]).subscribe({ error: (err) => errors.push(err) });
    return { items, released, errors, root, mounted };
  }

  it("leaves when it is taken off the list, and is let go of", () => {
    const { items, released, errors, root } = mountPairs(["a", "b", "c"]);
    assert.strictEqual(markup(root), pairs(["a", "b", "c"]));

    items.set(["a", "c"]);

    assert.deepStrictEqual(errors, []);
    assert.strictEqual(markup(root), pairs(["a", "c"]));
    assert.deepStrictEqual(released.sort(), ["b1", "b2"]);

    items.set([]);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(markup(root), "");
    assert.strictEqual(released.length, 6);
  });

  it("keeps the order of its nodes when it moves, in front of another or to the end", () => {
    const { items, errors, root, mounted } = mountPairs(["a", "b", "c"]);

    items.set(["c", "a", "b"]);
    assert.strictEqual(markup(root), pairs(["c", "a", "b"]));

    items.set(["a", "b", "c"]);
    assert.strictEqual(markup(root), pairs(["a", "b", "c"]));

    // Each item still knows its own span: one that leaves after the moves
    // takes its two elements and nothing else.
    items.set(["c", "a"]);
    assert.strictEqual(markup(root), pairs(["c", "a"]));
    assert.deepStrictEqual(errors, []);

    mounted.unsubscribe();
    assert.strictEqual(root.childNodes.length, 0);
  });

  it("renders any new order in that order", () => {
    const pool = [..."abcdefgh"];
    const order = fc.uniqueArray(fc.constantFrom(...pool), { maxLength: pool.length });
    fc.assert(
      fc.property(order, order, order, (first, second, third) => {
        const { items, errors, root, mounted } = mountPairs(first);
        items.set(second);
        assert.strictEqual(markup(root), pairs(second));
        items.set(third);
        assert.strictEqual(markup(root), pairs(third));
        mounted.unsubscribe();
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(root.childNodes.length, 0);
      }),
    );
  });
});

describe("nodes that are gone before their mounting is taken down", () => {
  it("takes the list down when an item fails after it was mounted", () => {
    const broken = Signal.of(false);
    /** @type {string[]} */
    const released = [];
    /** @type {unknown[]} */
    const errors = [];
    const root = document.createElement("ul");
    just(root, [
      children(
        list(
          () => ["a", "b"],
          (name) =>
            $("li", [
              () => onCleanup(() => released.push(name)),
              () => {
                if (name === "a" && broken.get()) {
                  throw new Error("a failed");
                }
              },
            ]),
        ),
      ),
    ]).subscribe({ error: (err) => errors.push(err) });
    assert.strictEqual(markup(root), "<li></li><li></li>");

    // The failure reaches the root, which takes the tree out from the top
    // while the list is still closing. The list finds its items' nodes gone
    // and lets the items go all the same.
    broken.set(true);

    assert.strictEqual(errors.length, 1);
    assert.match(String(errors[0]), /a failed/);
    assert.deepStrictEqual(released.sort(), ["a", "b"]);
    assert.strictEqual(root.childNodes.length, 0);
  });

  it("lets go of the children a second children() on the element replaced", () => {
    /** @type {string[]} */
    const released = [];
    const root = document.createElement("main");
    const mounted = just(root, [
      children($("i", [() => onCleanup(() => released.push("first"))])),
      children($("b", [() => onCleanup(() => released.push("second"))])),
    ]).subscribe();
    assert.strictEqual(markup(root), "<b></b>");

    mounted.unsubscribe();

    assert.deepStrictEqual(released, ["first", "second"]);
    assert.strictEqual(markup(root), "");
  });
});
