import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  component,
  createProperty,
  Derived,
  Effect,
  effectsOnly,
  just,
  observable,
  ReactiveMap,
  Signal,
  store,
  Stream,
  Subject,
} from "justdom-signal";
import { $hmr } from "./index.js";

/**
 * @import { Source, Subscribable } from "justdom-signal";
 * @import { HotContext } from "./index.js";
 */

/**
 * A stand-in for `import.meta.hot`: the one part of it the runtime uses is
 * the `data` object Vite keeps across every version of a module.
 *
 * @returns {HotContext}
 */
function fakeHot() {
  return { data: {} };
}

/**
 * One evaluation of a module defining a single export: register it and, as
 * the transformed module's footer does, let it take effect.
 *
 * @template T
 * @param {HotContext} hot
 * @param {string} name
 * @param {T} value
 * @returns {T}
 */
function reload(hot, name, value) {
  const module = $hmr(hot);
  const exported = module.reloadable(name, value);
  module.commit();
  return exported;
}

/**
 * Everything a source has said so far, and the handle to stop listening.
 *
 * @template T
 * @param {Subscribable<T>} source
 */
function collect(source) {
  /** @type {T[]} */
  const values = [];
  const subscription = source.subscribe({
    next: (value) => {
      values.push(value);
    },
  });
  return { values, subscription };
}

describe("a function export", () => {
  test("re-runs the computation that called it, with the new definition", () => {
    const hot = fakeHot();
    const double = reload(hot, "double", (/** @type {number} */ n) => n * 2);

    /** @type {number[]} */
    const seen = [];
    const effect = new Effect(() => {
      seen.push(double(21));
    });
    assert.deepStrictEqual(seen, [42]);

    const again = reload(hot, "double", (/** @type {number} */ n) => n * 3);
    assert.strictEqual(again, double, "the module exports the same wrapper every time");
    assert.deepStrictEqual(seen, [42, 63], "the reload was a write the effect depends on");
    effect.dispose();
  });

  test("outside a computation it simply calls the current definition", () => {
    const hot = fakeHot();
    const greet = reload(hot, "greet", (/** @type {string} */ who) => `hello ${who}`);
    assert.strictEqual(greet("world"), "hello world");
    reload(hot, "greet", (/** @type {string} */ who) => `goodbye ${who}`);
    assert.strictEqual(greet("world"), "goodbye world");
  });

  test("passes `this`, the arguments and `new` through", () => {
    const hot = fakeHot();
    function Point(/** @type {number} */ x, /** @type {number} */ y) {
      // @ts-expect-error — an old-style constructor, for `new` to have something to construct.
      this.x = x;
      // @ts-expect-error
      this.y = y;
    }
    const Reloadable = /** @type {any} */ (reload(hot, "Point", Point));
    const point = new Reloadable(1, 2);
    assert.deepStrictEqual({ x: point.x, y: point.y }, { x: 1, y: 2 });
    assert.strictEqual(Reloadable.name, "Point");
    assert.strictEqual(Reloadable.length, 2);

    const method = reload(hot, "method", function () {
      // @ts-expect-error — `this` is whatever the call supplied.
      return this.tag;
    });
    assert.strictEqual(method.call({ tag: "bound" }), "bound");
  });

  test("is the current definition to everything but identity", () => {
    const hot = fakeHot();
    const Vec = /** @type {any} */ (function Vec() {});
    Vec.ZERO = "zero";
    Vec.prototype.len = () => 0;
    const Exported = /** @type {any} */ (reload(hot, "Vec", Vec));

    assert.strictEqual(Exported.ZERO, "zero", "a static member reads through");
    assert.ok("ZERO" in Exported);
    assert.ok(Object.keys(Exported).includes("ZERO"));
    assert.strictEqual(Exported.prototype, Vec.prototype);
    assert.ok(new Exported() instanceof Exported, "`instanceof` looks at the current prototype");
    assert.ok(new Exported() instanceof Vec);
    assert.strictEqual(new Exported().len(), 0);

    class Sub extends Exported {
      more() {
        return 1;
      }
    }
    const sub = new Sub();
    assert.ok(sub instanceof Sub, "`new.target` reaches the definition");
    assert.strictEqual(sub.more(), 1);
    assert.strictEqual(sub.len(), 0);
    assert.strictEqual(Sub.ZERO, "zero", "statics are inherited through the stand-in");

    Exported.ONE = "one";
    assert.strictEqual(Vec.ZERO, "zero");
    assert.strictEqual(/** @type {any} */ (Vec).ONE, "one", "a write lands on the definition");

    const Vec2 = /** @type {any} */ (function Vec2() {});
    Vec2.ZERO = "zero!";
    reload(hot, "Vec", Vec2);
    assert.strictEqual(Exported.ZERO, "zero!", "and after a reload, on the new one");
    assert.ok(new Exported() instanceof Vec2);
  });

  test("answers for `prototype` even when the definition has none", () => {
    const hot = fakeHot();
    const arrow = /** @type {any} */ (reload(hot, "arrow", () => 1));
    // A proxy over a function must report the target's non-configurable
    // `prototype`; a falsish answer here would be a TypeError, not `false`.
    assert.ok("prototype" in arrow);
    assert.strictEqual(Reflect.deleteProperty(arrow, "prototype"), false);
    assert.ok(Object.getOwnPropertyNames(arrow).includes("prototype"));
    assert.strictEqual(arrow(), 1);
  });

  test("a call that throws still records the dependency", () => {
    const hot = fakeHot();
    const risky = reload(hot, "risky", () => {
      throw new Error("bug");
    });
    const outcome = new Derived(() => {
      try {
        return risky();
      } catch (err) {
        return `caught: ${/** @type {Error} */ (err).message}`;
      }
    });
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => {
      seen.push(outcome.get());
    });
    assert.deepStrictEqual(seen, ["caught: bug"]);

    reload(hot, "risky", () => "fixed");
    assert.deepStrictEqual(
      seen,
      ["caught: bug", "fixed"],
      "the fix reaches the caller that caught the bug",
    );
    effect.dispose();
  });

  test("a dependent node is a dependent of the module, and takes the cutoff", () => {
    const hot = fakeHot();
    const answer = reload(hot, "answer", () => 42);
    const doubled = new Derived(() => answer() * 2);
    let evaluations = 0;
    const effect = new Effect(() => {
      doubled.get();
      evaluations += 1;
    });
    assert.strictEqual(evaluations, 1);

    // The same answer from different code: the derived recomputes, the effect
    // does not.
    reload(hot, "answer", () => 40 + 2);
    assert.strictEqual(doubled.getEvaluations(), 2);
    assert.strictEqual(evaluations, 1, "an unchanged value stops at the `Derived`");

    reload(hot, "answer", () => 43);
    assert.strictEqual(evaluations, 2);
    effect.dispose();
  });
});

describe("what a reload waits for", () => {
  test("a new definition takes effect at commit, not at registration", () => {
    const hot = fakeHot();
    const answer = reload(hot, "answer", () => 1);
    /** @type {number[]} */
    const seen = [];
    const effect = new Effect(() => {
      seen.push(answer());
    });

    // The module body, still evaluating: an export registered above a
    // `const` it reads. Re-running the effect now would read the `const`
    // before its initialisation.
    const module = $hmr(hot);
    /** @type {number | undefined} */
    let later;
    module.reloadable("answer", () => /** @type {number} */ (later));
    assert.deepStrictEqual(seen, [1], "nothing has run the new code yet");
    later = 2;
    module.commit();
    assert.deepStrictEqual(
      seen,
      [1, 2],
      "and at the end of the body it does, with `later` in place",
    );
    effect.dispose();
  });

  test("a dependent of several exports runs once per reload", () => {
    const hot = fakeHot();
    const first = $hmr(hot);
    const a = first.reloadable("a", () => 1);
    const b = first.reloadable("b", () => 10);
    first.commit();
    let runs = 0;
    const effect = new Effect(() => {
      a() + b();
      runs += 1;
    });
    assert.strictEqual(runs, 1);

    const next = $hmr(hot);
    next.reloadable("a", () => 2);
    next.reloadable("b", () => 20);
    next.commit();
    assert.strictEqual(runs, 2, "one batch, one run");
    effect.dispose();
  });

  test("a module that never commits leaves its previous definitions standing", () => {
    const hot = fakeHot();
    const answer = reload(hot, "answer", () => 1);
    // An evaluation that registered and then threw before its footer.
    $hmr(hot).reloadable("answer", () => 2);
    assert.strictEqual(answer(), 1);
  });
});

describe("a factory export", () => {
  test("switches the mounted instance without re-running whoever mounted it", () => {
    const hot = fakeHot();
    const Greeting = reload(
      hot,
      "Greeting",
      component((/** @type {string} */ who) => just(`hello ${who}`)),
    );

    let mounts = 0;
    // The parent: a computation that calls the factory, the way one component
    // mounts another.
    const parent = observable(() => {
      mounts += 1;
      return Greeting("world");
    });
    /** @type {string[]} */
    const values = [];
    const subscription = parent.subscribe((source) => {
      source.subscribe((value) => values.push(value));
    });
    assert.deepStrictEqual(values, ["hello world"]);
    assert.strictEqual(mounts, 1);

    reload(
      hot,
      "Greeting",
      component((/** @type {string} */ who) => just(`goodbye ${who}`)),
    );
    assert.deepStrictEqual(
      values,
      ["hello world", "goodbye world"],
      "the caller's arguments survive",
    );
    assert.strictEqual(mounts, 1, "the parent was not touched");
    subscription.unsubscribe();
  });

  test("the previous definition is unsubscribed before the next is taken", () => {
    const hot = fakeHot();
    /** @type {string[]} */
    const order = [];
    /**
     * @param {string} label
     * @returns {Source<string>}
     */
    const tracked = (label) =>
      new Stream((subscriber) => {
        order.push(`up:${label}`);
        subscriber.next(label);
        return () => {
          order.push(`down:${label}`);
        };
      });

    const Behaviour = reload(
      hot,
      "Behaviour",
      component(() => tracked("first")),
    );
    const { subscription } = collect(Behaviour());

    reload(
      hot,
      "Behaviour",
      component(() => tracked("second")),
    );
    assert.deepStrictEqual(order, ["up:first", "down:first", "up:second"]);

    subscription.unsubscribe();
    assert.deepStrictEqual(order, ["up:first", "down:first", "up:second", "down:second"]);
  });

  test("a definition nothing subscribed to costs nothing on reload", () => {
    const hot = fakeHot();
    let runs = 0;
    const Behaviour = reload(
      hot,
      "Behaviour",
      effectsOnly(() => {
        runs += 1;
      }),
    );
    Behaviour();
    reload(
      hot,
      "Behaviour",
      effectsOnly(() => {
        runs += 1;
      }),
    );
    assert.strictEqual(runs, 0, "a factory is not run until something subscribes");
  });

  test("a source built before the reload is mounted as it is, not rebuilt", () => {
    const hot = fakeHot();
    let built = 0;
    const Thing = reload(hot, "Thing", () => {
      built += 1;
      return just("one");
    });
    const source = Thing();
    assert.strictEqual(built, 1);
    const { values } = collect(source);
    assert.deepStrictEqual(values, ["one"]);
    assert.strictEqual(built, 1, "the call's own result was what got mounted");
  });
});

describe("a source export", () => {
  test("follows the module that replaced it", () => {
    // The `stylesheet` shape: what the module defines is a `Stream`, already
    // built, with nothing further to wait for.
    const hot = fakeHot();
    const style = reload(hot, "style", just("first"));
    const { values } = collect(style);
    assert.deepStrictEqual(values, ["first"], "the value it is holding, on subscribe");

    reload(hot, "style", just("second"));
    assert.deepStrictEqual(values, ["first", "second"], "and the one that replaced it");
  });
});

describe("a derived export", () => {
  test("is a node whose dependents follow the module", () => {
    const hot = fakeHot();
    const input = Signal.of(2);
    const squared = reload(hot, "squared", new Derived(() => input.get() ** 2));
    assert.ok(squared instanceof Derived);

    /** @type {number[]} */
    const seen = [];
    const effect = new Effect(() => {
      seen.push(squared.get());
    });
    input.set(3);
    assert.deepStrictEqual(seen, [4, 9]);

    reload(hot, "squared", new Derived(() => input.get() ** 3));
    assert.deepStrictEqual(seen, [4, 9, 27], "the new node, read by the old dependents");
    input.set(2);
    assert.deepStrictEqual(seen, [4, 9, 27, 8], "and its inputs still move it");
    effect.dispose();
  });
});

describe("a store export", () => {
  test("is kept, and takes the new definition key by key", () => {
    const hot = fakeHot();
    const theme = reload(hot, "theme", store({ accent: "#f00", spacing: 8 }));
    /** @type {string[]} */
    const accents = [];
    /** @type {number[]} */
    const spacings = [];
    const a = new Effect(() => {
      accents.push(theme.accent);
    });
    const b = new Effect(() => {
      spacings.push(theme.spacing);
    });

    const next = $hmr(hot);
    const again = next.reloadable("theme", store({ accent: "#0f0", spacing: 8 }));
    assert.strictEqual(again, theme, "the instance is the one the module and its importers share");
    assert.deepStrictEqual(accents, ["#f00"], "nothing moves before the body has run");
    next.commit();
    assert.deepStrictEqual(accents, ["#f00", "#0f0"], "the reader of the changed key ran");
    assert.deepStrictEqual(spacings, [8], "the reader of the unchanged key did not");
    assert.strictEqual(next.invalidation({ theme: again }), null);
    a.dispose();
    b.dispose();
  });

  test("follows an edit to a getter's body", () => {
    const palette = store({ amber: "#fb0", ivory: "#eed" });
    const hot = fakeHot();
    const theme = reload(
      hot,
      "theme",
      store({
        get accent() {
          return palette.amber;
        },
      }),
    );
    /** @type {string[]} */
    const accents = [];
    const a = new Effect(() => {
      accents.push(theme.accent);
    });

    const next = $hmr(hot);
    next.reloadable(
      "theme",
      store({
        get accent() {
          return palette.ivory;
        },
      }),
    );
    next.commit();
    palette.ivory = "#fff";
    palette.amber = "#f80";
    assert.deepStrictEqual(accents, ["#fb0", "#eed", "#fff"], "the new getter, still computed");
    a.dispose();
  });

  test("keeps the keys the program wrote and follows the rest", () => {
    const hot = fakeHot();
    const settings = reload(hot, "settings", store({ volume: 1, theme: "light" }));
    settings.volume = 5;
    const next = $hmr(hot);
    const again = next.reloadable("settings", store({ volume: 2, theme: "dark" }));
    next.commit();
    assert.strictEqual(again.volume, 5, "the program's write stays");
    assert.strictEqual(again.theme, "dark", "the edited initial value shows");
  });

  test("keeps a key the program added and one it deleted", () => {
    const hot = fakeHot();
    const scores = reload(
      hot,
      "scores",
      store(/** @type {Record<string, number>} */ ({ a: 1, b: 2 })),
    );
    scores.c = 3;
    delete scores.b;
    const next = $hmr(hot);
    next.reloadable("scores", store({ a: 1, b: 2 }));
    next.commit();
    assert.deepStrictEqual({ ...scores }, { a: 1, c: 3 });
  });
});

describe("a state export", () => {
  test("a signal keeps what the application wrote to it", () => {
    const hot = fakeHot();
    const locale = reload(hot, "locale", Signal.of("en"));
    locale.set("pl");

    const next = $hmr(hot);
    const again = next.reloadable("locale", Signal.of("en"));
    assert.strictEqual(again, locale, "the first instance is the one exported");
    assert.strictEqual(again.get(), "pl", "and it still holds what was written");
    assert.strictEqual(next.invalidation({ locale: again }), null);
  });

  test("a store keeps what was written and takes a getter added in source", () => {
    const hot = fakeHot();
    const settings = reload(hot, "settings", store({ volume: 1 }));
    settings.volume = 5;
    /** @type {number[]} */
    const volumes = [];
    const a = new Effect(() => {
      volumes.push(settings.volume);
    });

    const next = $hmr(hot);
    const again = next.reloadable(
      "settings",
      store({
        volume: 1,
        get loud() {
          return this.volume > 3;
        },
      }),
    );
    assert.strictEqual(again, settings, "the first instance is the one exported");
    assert.strictEqual(again.loud, undefined, "nothing moves before the body has run");
    next.commit();
    assert.strictEqual(settings.volume, 5, "what was written stays");
    assert.strictEqual(again.loud, true, "the getter added in source reads it");
    assert.deepStrictEqual(volumes, [5], "the reader of the kept key did not run");
    assert.strictEqual(next.invalidation({ settings: again }), null);
    a.dispose();
  });

  test("a store, a reactive map, a subject and a context property are kept the same way", () => {
    const hot = fakeHot();
    const first = $hmr(hot);
    const settings = first.reloadable("settings", store({ volume: 1 }));
    const scores = first.reloadable("scores", new ReactiveMap());
    const clicks = first.reloadable("clicks", new Subject());
    const theme = first.reloadable(
      "theme",
      createProperty(() => "light"),
    );
    settings.volume = 5;
    scores.set("a", 10);

    const next = $hmr(hot);
    assert.strictEqual(next.reloadable("settings", store({ volume: 1 })), settings);
    assert.strictEqual(next.reloadable("scores", new ReactiveMap()), scores);
    assert.strictEqual(next.reloadable("clicks", new Subject()), clicks);
    assert.strictEqual(
      next.reloadable(
        "theme",
        createProperty(() => "light"),
      ),
      theme,
    );
    next.commit();
    assert.strictEqual(settings.volume, 5, "reshaped with the same definition, the value stays");
    assert.strictEqual(scores.get("a"), 10);
    assert.strictEqual(next.invalidation({ settings, scores, clicks, theme }), null);
  });

  test("an array store is kept, and keeps its elements once the program writes to it", () => {
    const hot = fakeHot();
    const levels = reload(hot, "levels", store([{ name: "a" }, { name: "b" }]));
    const first = levels[0];
    /** @type {string[]} */
    const seen = [];
    const a = new Effect(() => {
      seen.push(levels.map((level) => level.name).join(","));
    });
    assert.strictEqual(reload(hot, "levels", store([{ name: "a" }, { name: "c" }])), levels);
    assert.strictEqual(levels[0], first, "an element store is reshaped in place");
    levels.push({ name: "d" });
    reload(hot, "levels", store([{ name: "x" }]));
    assert.deepStrictEqual(
      seen,
      ["a,b", "a,c", "a,c,d", "x,c,d"],
      "what the program pushed stays, and an element store still follows the source",
    );
    a.dispose();
  });

  test("a store that changed kind cannot be taken in place", () => {
    const hot = fakeHot();
    reload(hot, "thing", store({ a: 1 }));
    const next = $hmr(hot);
    const replaced = next.reloadable("thing", store([1]));
    next.commit();
    assert.ok(Array.isArray(replaced), "the new definition is what the new module gets");
    assert.match(String(next.invalidation({ thing: replaced })), /thing cannot be replaced/);
  });

  test("state that changed shape cannot be taken in place", () => {
    const hot = fakeHot();
    reload(hot, "thing", Signal.of(1));
    const next = $hmr(hot);
    const replaced = next.reloadable("thing", new ReactiveMap());
    assert.ok(replaced instanceof ReactiveMap, "the new definition is what the new module gets");
    assert.match(String(next.invalidation({ thing: replaced })), /thing cannot be replaced/);
  });

  test("an object that merely looks like state is still a value", () => {
    const hot = fakeHot();
    const property = createProperty(() => 1);
    reload(hot, "lookalike", { get: property.get, set: property.set });
    const next = $hmr(hot);
    next.reloadable("lookalike", { get: property.get, set: property.set });
    assert.match(String(next.invalidation({ lookalike: null })), /lookalike cannot be replaced/);
  });
});

describe("invalidation", () => {
  test("an update whose every export was followed is taken in place", () => {
    const hot = fakeHot();
    reload(hot, "fn", () => 1);
    reload(hot, "style", just("a"));
    reload(hot, "LIMIT", 10);
    const next = $hmr(hot);
    const fn = next.reloadable("fn", () => 2);
    const style = next.reloadable("style", just("b"));
    const LIMIT = next.reloadable("LIMIT", 10);
    assert.strictEqual(next.invalidation({ fn, style, LIMIT }), null);
  });

  test("a wrapper re-exported under another name is the same thing", () => {
    const hot = fakeHot();
    const first = $hmr(hot);
    const Board = first.reloadable("Board", () => "board");
    assert.strictEqual(first.reloadable("default", Board), Board);
    const next = $hmr(hot);
    const again = next.reloadable("Board", () => "board!");
    assert.strictEqual(next.reloadable("default", again), Board);
    assert.strictEqual(next.invalidation({ Board, default: Board }), null);
  });

  test("a value that changed cannot be taken in place", () => {
    const hot = fakeHot();
    reload(hot, "LIMIT", 10);
    const next = $hmr(hot);
    next.reloadable("LIMIT", 20);
    assert.match(String(next.invalidation({ LIMIT: 20 })), /LIMIT cannot be replaced/);
  });

  test("an object is a different value every evaluation", () => {
    const hot = fakeHot();
    reload(hot, "palette", { red: "#f00" });
    const next = $hmr(hot);
    next.reloadable("palette", { red: "#f00" });
    assert.match(String(next.invalidation({ palette: {} })), /palette cannot be replaced/);
  });

  test("a class is left alone rather than wrapped", () => {
    const hot = fakeHot();
    class Thing {}
    assert.strictEqual(reload(hot, "Thing", Thing), Thing);
    const next = $hmr(hot);
    class Thing2 {}
    next.reloadable("Thing", Thing2);
    assert.match(String(next.invalidation({ Thing: Thing2 })), /Thing cannot be replaced/);
  });

  test("a definition that changed kind cannot be taken in place", () => {
    const hot = fakeHot();
    reload(hot, "thing", () => 1);
    const next = $hmr(hot);
    next.reloadable("thing", just(1));
    assert.match(String(next.invalidation({ thing: null })), /thing cannot be replaced/);
    // The evaluation the invalidation provokes finds the entry current again.
    const after = $hmr(hot);
    after.reloadable("thing", just(2));
    assert.strictEqual(after.invalidation({ thing: null }), null);
  });

  test("an export nothing registered, and one that went missing", () => {
    const hot = fakeHot();
    reload(hot, "a", () => 1);
    reload(hot, "b", () => 2);
    let next = $hmr(hot);
    next.reloadable("a", () => 1);
    next.reloadable("b", () => 2);
    assert.match(String(next.invalidation({ a: 1, b: 2, c: 3 })), /c is not a reloadable export/);
    next = $hmr(hot);
    next.reloadable("a", () => 1);
    assert.match(String(next.invalidation({ a: 1 })), /b is no longer exported/);
  });

  test("the previous module's reloader answers for the latest evaluation", () => {
    const hot = fakeHot();
    const previous = $hmr(hot);
    previous.reloadable("LIMIT", 10);
    const latest = $hmr(hot);
    latest.reloadable("LIMIT", 11);
    // The update reaches the *previous* module's accept callback, which holds
    // the previous reloader.
    assert.match(String(previous.invalidation({ LIMIT: 11 })), /LIMIT cannot be replaced/);
  });

  test("without a hot context every evaluation stands on its own", () => {
    const fn = $hmr(undefined).reloadable("fn", () => 1);
    const again = $hmr(undefined).reloadable("fn", () => 2);
    assert.notStrictEqual(fn, again);
    assert.strictEqual(fn(), 1);
    assert.strictEqual(again(), 2);
  });
});
