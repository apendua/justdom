import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mergePanelOptions,
  PanelOptionsContext,
  resolveKeyboard,
  withPanelOptions,
} from "./panelOptions.js";

/**
 * @import {PortalOptions} from './portal.js';
 * @import {PanelOptions} from './panelOptions.js';
 */

const create = () => {
  throw new Error("not called here");
};

describe("mergePanelOptions", () => {
  test("keeps what the panel leaves out, and what it sets to undefined", () => {
    assert.deepEqual(
      mergePanelOptions({ maxTextScale: 2, atomic: false }, { maxTextScale: undefined }),
      { maxTextScale: 2, atomic: false },
    );
  });

  test("lets the panel's value win for a plain option", () => {
    assert.deepEqual(mergePanelOptions({ maxTextScale: 2, priority: 1 }, { maxTextScale: 4 }), {
      maxTextScale: 4,
      priority: 1,
    });
  });

  test("spreads one keyboard over the other", () => {
    assert.deepEqual(
      mergePanelOptions({ keyboard: { create, gap: 5 } }, { keyboard: { gap: 20 } }),
      {
        keyboard: { create, gap: 20 },
      },
    );
  });

  test("lets `keyboard: false` win over an inherited keyboard", () => {
    assert.deepEqual(mergePanelOptions({ keyboard: { create } }, { keyboard: false }), {
      keyboard: false,
    });
  });

  test("takes `false` or options for the loading frame, and not `true`", () => {
    /** @type {PanelOptions[]} */
    const allowed = [{ loadingFrame: false }, { loadingFrame: {} }, { loadingFrame: { delay: 0 } }];
    assert.equal(allowed.length, 3);
    /** @type {PanelOptions} */
    // @ts-expect-error -- the frame is on when left out; `true` says nothing more.
    const refused = { loadingFrame: true };
    assert.ok(refused);
  });

  test("spreads one loading frame over the other, and lets `false` replace it", () => {
    assert.deepEqual(
      mergePanelOptions({ loadingFrame: { delay: 100 } }, { loadingFrame: { minimumTime: 0 } }),
      { loadingFrame: { delay: 100, minimumTime: 0 } },
    );
    assert.deepEqual(mergePanelOptions({ loadingFrame: { delay: 100 } }, { loadingFrame: false }), {
      loadingFrame: false,
    });
    assert.deepEqual(mergePanelOptions({ loadingFrame: false }, { loadingFrame: { delay: 0 } }), {
      loadingFrame: { delay: 0 },
    });
  });

  test("spreads one set of haptics over the other, and lets `false` replace it", () => {
    assert.deepEqual(
      mergePanelOptions(
        { haptics: { flavor: "knock", strength: 0.5 } },
        { haptics: { hover: false } },
      ),
      { haptics: { flavor: "knock", strength: 0.5, hover: false } },
    );
    assert.deepEqual(mergePanelOptions({ haptics: { flavor: "knock" } }, { haptics: false }), {
      haptics: false,
    });
    assert.deepEqual(mergePanelOptions({ haptics: false }, { haptics: {} }), { haptics: {} });
  });

  test("takes `false` or options for the haptics, and not `true`", () => {
    /** @type {PanelOptions[]} */
    const allowed = [{ haptics: false }, { haptics: {} }, { haptics: { flavor: "buzz" } }];
    assert.equal(allowed.length, 3);
    /** @type {PanelOptions} */
    // @ts-expect-error -- haptics are on when left out; `true` says nothing more.
    const refused = { haptics: true };
    assert.ok(refused);
  });

  test("passes a panel's own options through untouched", () => {
    const root = document.createElement("div");
    /** @type {PortalOptions} */
    const own = { root };
    const merged = mergePanelOptions({ atomic: false }, own);
    assert.equal(merged.root, root);
    assert.equal(merged.atomic, false);
  });

  test("leaves both arguments as they were", () => {
    const base = { keyboard: { create, gap: 5 } };
    const own = { keyboard: { gap: 20 } };
    mergePanelOptions(base, own);
    assert.deepEqual(base, { keyboard: { create, gap: 5 } });
    assert.deepEqual(own, { keyboard: { gap: 20 } });
  });
});

describe("withPanelOptions", () => {
  test("is empty until something sets it", () => {
    assert.deepEqual(PanelOptionsContext.get({}), {});
  });

  test("lays a nested scope over the one around it", () => {
    const outer = withPanelOptions({}, { maxTextScale: 2, keyboard: { create } });
    const inner = withPanelOptions(outer, { keyboard: { gap: 20 }, atomic: false });
    assert.deepEqual(PanelOptionsContext.get(inner), {
      maxTextScale: 2,
      atomic: false,
      keyboard: { create, gap: 20 },
    });
    assert.deepEqual(
      PanelOptionsContext.get(outer),
      { maxTextScale: 2, keyboard: { create } },
      "the outer scope is untouched",
    );
  });
});

describe("resolveKeyboard", () => {
  test("is none for nothing, for false, and for options with no factory", () => {
    assert.equal(resolveKeyboard(undefined), null);
    assert.equal(resolveKeyboard(false), null);
    assert.equal(resolveKeyboard({ gap: 20 }), null);
  });

  test("is the options once there is a factory", () => {
    const keyboard = { create, gap: 20 };
    assert.equal(resolveKeyboard(keyboard), keyboard);
  });
});
