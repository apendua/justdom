/**
 * Event-sequence goldens. Each one records what a page hears, gesture by
 * gesture, from a hand driven through the real interaction manager onto a
 * real panel.
 *
 * A gesture is a script of steps. A step aims the ray, closes or opens a
 * button, changes the page or loses the hand. For each step the golden
 * records every pointer, mouse and drag event the page heard, with its
 * target, `bubbles`, `cancelable`, `button` and point, and for a pointer
 * event which pointer it came from, its `pointerType` and whether it is
 * the primary one. It records every ray event that got past the panel to
 * the scene above it. After the step it records which elements carry
 * `data-xr-hover` and `data-xr-active` and where each scrolling list
 * stands. The recordings are in `pointerGoldens.json` beside this file.
 *
 * They pin today's behaviour, which is not always the behaviour anybody
 * wants. A hand lost mid-press releases nothing yet, and the plan means to
 * change that. They are there so that a change to how rays become events is
 * a change somebody sees. A golden that has to change is a behaviour change.
 * It goes in a commit of its own that says why the old sequence was wrong,
 * as section 10 of `docs/freedom-architecture-plan.md` asks.
 *
 * To record them again after such a change:
 *
 *   UPDATE_GOLDENS=1 node --import ./src/test/setup-jsdom.js \
 *     --test src/elements/pointerGoldens.test.js
 *
 * and read the diff of the JSON file before committing it. A gesture with
 * no recording fails rather than recording one, unless that is asked for.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { clientRect } from "../test/clientRect.js";
import { drain, settle } from "../test/portalHarness.js";
import { rayHand } from "../test/rayHand.js";
import { describeScroller } from "../test/scroller.js";
import { createPortal } from "./portal.js";

const GOLDENS = new URL("./pointerGoldens.json", import.meta.url);
const UPDATE = process.env.UPDATE_GOLDENS === "1";

/** @type {Record<string, string[]>} */
const goldens = JSON.parse(readFileSync(GOLDENS, "utf8"));
/** @type {Record<string, string[]>} */
const recorded = {};

after(() => {
  if (UPDATE) {
    writeFileSync(GOLDENS, `${JSON.stringify({ ...goldens, ...recorded }, null, 2)}\n`);
  }
});

/** @typedef {readonly [number, number, number, number]} Rect */

/**
 * An element of a page, laid out where `at` says: its left, top, width and
 * height on the page. jsdom lays nothing out, so every element says.
 *
 * @typedef {object} Spec
 * @property {string} id
 * @property {string} [style]
 * @property {Rect} at
 * @property {boolean} [draggable] `draggable="true"`.
 * @property {number} [scroll] A scrolling list, with this much content in
 *   it; it shows its own height of it.
 * @property {Spec[]} [children]
 */

/** The mouse and drag events a page can hear from a ray. */
const DOM_TYPES = [
  "pointerdown",
  "pointerup",
  "pointermove",
  "mousedown",
  "mouseup",
  "click",
  "contextmenu",
  "mousemove",
  "dragstart",
  "drag",
  "dragenter",
  "dragover",
  "dragleave",
  "drop",
  "dragend",
];

/** The ray events a panel is meant to stop, all but the grip's start. */
const RAY_TYPES = [
  "selectstart",
  "selectend",
  "select",
  "selectmissed",
  "squeezestart",
  "squeezeend",
  "squeeze",
  "squeezemissed",
];

/**
 * Build the page, mirror it into a panel, and record what it hears.
 *
 * @param {Spec[]} children Under a 400 by 300 root at the page's corner.
 * @param {{ accept?: boolean, capture?: boolean, cancel?: boolean }} [options]
 *   Whether a list takes what is dropped on it, since every scrolling list
 *   sorts its rows by drag and drop; whether an element captures the
 *   pointer that presses it, as a page that drags by capture does; and
 *   whether the page cancels `pointerdown`, as a page that takes a press
 *   as a pointer does.
 */
async function page(children, { accept = true, capture = false, cancel = false } = {}) {
  const root = document.createElement("div");
  root.id = "root";
  /** @type {Map<string, HTMLElement>} */
  const elements = new Map();
  /** @type {Map<string, Rect>} */
  const places = new Map();

  /**
   * @param {HTMLElement} parent
   * @param {Spec} spec
   */
  const build = (parent, spec) => {
    const element = document.createElement("div");
    element.id = spec.id;
    element.style.cssText = spec.style ?? "";
    if (spec.draggable) {
      element.setAttribute("draggable", "true");
    }
    if (spec.scroll !== undefined) {
      element.style.overflow = "hidden";
      describeScroller(element, { client: spec.at[3], scroll: spec.scroll });
      sortable(element, accept);
    }
    element.getBoundingClientRect = () => clientRect(...spec.at);
    elements.set(spec.id, element);
    places.set(spec.id, spec.at);
    parent.appendChild(element);
    for (const child of spec.children ?? []) {
      build(element, child);
    }
  };
  root.getBoundingClientRect = () => clientRect(0, 0, 400, 300);
  for (const child of children) {
    build(root, child);
  }
  document.body.appendChild(root);
  if (cancel) {
    root.addEventListener("pointerdown", (event) => event.preventDefault());
  }
  if (capture) {
    root.addEventListener("pointerdown", (event) => {
      const { pointerId } = /** @type {PointerEvent} */ (event);
      /** @type {Element} */ (event.target).setPointerCapture(pointerId);
    });
  }

  const manager = new InteractionManager();
  const ctx = InteractionContext.set({}, manager);
  const portal = createPortal(ctx, { root, budget: 0 });
  const scene = new THREE.Group();
  portal.addTo(scene);
  await settle(portal);
  const panel = scene.children[0];

  /** @type {string[]} */
  const lines = [];
  /**
   * Each pointer the page has heard of, numbered from 1 in the order it was
   * first heard. A hand's `pointerId` is given out once per hand for the
   * life of the module, so it depends on which tests ran before; what a
   * golden pins is which pointer an event came from.
   *
   * @type {Map<number, number>}
   */
  const pointers = new Map();
  /** @param {Event} event */
  const hear = (event) => {
    const { bubbles, cancelable, button, clientX, clientY } = /** @type {MouseEvent} */ (event);
    const target = /** @type {Element} */ (event.target);
    let pointer = "";
    if (event instanceof PointerEvent) {
      const { pointerId, pointerType, isPrimary } = event;
      let n = pointers.get(pointerId);
      if (n === undefined) {
        n = pointers.size + 1;
        pointers.set(pointerId, n);
      }
      pointer = ` pointer ${n} ${pointerType}${isPrimary ? " primary" : ""}`;
    }
    lines.push(
      `${event.type} #${target.id}` +
        ` ${bubbles ? "bubbles" : "-"} ${cancelable ? "cancelable" : "-"}` +
        ` button ${button} at ${Math.round(clientX)},${Math.round(clientY)}${pointer}`,
    );
  };
  // On the way down, so that an event which does not bubble is heard too.
  for (const type of DOM_TYPES) {
    document.addEventListener(type, hear, true);
  }
  for (const type of RAY_TYPES) {
    scene.addEventListener(/** @type {never} */ (type), () => lines.push(`escaped ${type}`));
  }

  /** The flags on every element, and where each list stands, in order. */
  const state = () => {
    /** @type {string[]} */
    const parts = [];
    for (const [id, element] of elements) {
      const flags = [
        element.dataset.xrHover && "hover",
        element.dataset.xrActive && "active",
      ].filter(Boolean);
      if (flags.length > 0) {
        parts.push(`#${id} ${flags.join(" ")}`);
      }
      if (element.style.overflow === "hidden" && element.scrollTop !== 0) {
        parts.push(`#${id} scrolled ${Math.round(element.scrollTop)}`);
      }
    }
    return `= ${parts.join(", ") || "nothing"}`;
  };

  const hands = [rayHand(manager), rayHand(manager)];

  return {
    elements,
    hands,
    /**
     * Where an element is laid out, as the point in it a hand aims at: its
     * middle, or a point at `dx`, `dy` from its corner.
     *
     * @param {string} id
     * @param {number} [dx]
     * @param {number} [dy]
     * @returns {[number, number]}
     */
    on(id, dx, dy) {
      const [left, top, width, height] = /** @type {Rect} */ (places.get(id));
      return [left + (dx ?? width / 2), top + (dy ?? height / 2)];
    },
    /**
     * Aim a hand at a point on the page, in px.
     *
     * @param {[number, number]} point
     * @param {number} [hand]
     */
    aim([x, y], hand = 0) {
      hands[hand].aim(panel, x, y);
    },
    /**
     * One step of the gesture: say what it is, do it, and record what the
     * page heard and the state it was left in.
     *
     * @param {string} label
     * @param {() => void | Promise<void>} act
     */
    async step(label, act) {
      lines.push(`> ${label}`);
      await act();
      lines.push(state());
    },
    lines,
    teardown() {
      for (const type of DOM_TYPES) {
        document.removeEventListener(type, hear, true);
      }
      hands.forEach((hand) => hand.remove());
      portal.disconnect();
      root.remove();
    },
  };
}

/**
 * A list that sorts its rows by drag and drop, written against the
 * browser's drag and drop alone: a row dropped on it goes before the row it
 * was dropped on, or last.
 *
 * @param {HTMLElement} list
 * @param {boolean} accept Whether it takes drops at all.
 */
function sortable(list, accept) {
  list.addEventListener("dragstart", (event) => {
    const { dataTransfer } = /** @type {DragEvent} */ (event);
    dataTransfer?.setData("text/plain", /** @type {HTMLElement} */ (event.target).id);
  });
  list.addEventListener("dragover", (event) => {
    if (accept) {
      event.preventDefault();
    }
  });
  list.addEventListener("drop", (event) => {
    event.preventDefault();
    const { dataTransfer } = /** @type {DragEvent} */ (event);
    const row = document.getElementById(dataTransfer?.getData("text/plain") ?? "");
    const target = /** @type {HTMLElement} */ (event.target);
    if (row) {
      list.insertBefore(row, target === list ? null : target);
    }
  });
}

/**
 * Hold a gesture's recording against its golden, or record it.
 *
 * @param {string} name
 * @param {string[]} lines
 */
function matches(name, lines) {
  recorded[name] = [...lines];
  if (UPDATE) {
    return;
  }
  assert.ok(name in goldens, `no golden recorded for "${name}"; see this file's header`);
  assert.deepEqual(lines, goldens[name]);
}

/** A clickable element. */
const POINTER = "cursor: pointer";

/** A button on its own, with nothing clickable inside or around it. */
/** @type {Spec[]} */
const LEAF = [{ id: "leaf", style: POINTER, at: [20, 20, 100, 40] }];

/** A clickable card with a clickable icon in it. */
/** @type {Spec[]} */
const NEST = [
  {
    id: "card",
    style: POINTER,
    at: [20, 20, 200, 100],
    children: [{ id: "icon", style: POINTER, at: [40, 40, 40, 40] }],
  },
];

/**
 * A list that scrolls, of clickable rows that are draggable too, and a
 * second list beside it to drop them on.
 */
/** @type {Spec[]} */
const LISTS = [
  {
    id: "list",
    at: [20, 20, 150, 120],
    scroll: 400,
    children: ["a", "b", "c"].map((id, index) => ({
      id,
      style: POINTER,
      draggable: true,
      at: [20, 20 + index * 40, 150, 40],
    })),
  },
  {
    id: "other",
    at: [220, 20, 150, 120],
    scroll: 400,
    children: [{ id: "d", style: POINTER, at: [220, 20, 150, 40] }],
  },
];

/** The same list with rows that are not draggable, so a press may scroll. */
/** @type {Spec[]} */
const SCROLLER = [
  {
    id: "list",
    at: [20, 20, 150, 120],
    scroll: 400,
    children: ["a", "b", "c"].map((id, index) => ({
      id,
      style: POINTER,
      at: [20, 20 + index * 40, 150, 40],
    })),
  },
];

/** Three positioned cards piled on each other, each clickable. */
/** @type {Spec[]} */
const PILE = ["p1", "p2", "p3"].map((id, index) => ({
  id,
  style: `${POINTER}; position: absolute; left: ${20 + index * 30}px; top: ${20 + index * 20}px`,
  at: [20 + index * 30, 20 + index * 20, 120, 80],
}));

describe("event-sequence goldens", () => {
  test("press and release on a leaf", async () => {
    const g = await page(LEAF);
    await g.step("aim at #leaf", () => g.aim(g.on("leaf")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("aim away", () => g.hands[0].turnAway());
    matches("press and release on a leaf", g.lines);
    g.teardown();
  });

  test("press and release on a nested pair", async () => {
    const g = await page(NEST);
    await g.step("aim at #icon", () => g.aim(g.on("icon")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    matches("press and release on a nested pair", g.lines);
    g.teardown();
  });

  test("release off the element", async () => {
    const g = await page([...LEAF, { id: "far", style: POINTER, at: [200, 200, 100, 40] }]);
    await g.step("aim at #leaf", () => g.aim(g.on("leaf")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("aim at #far", () => g.aim(g.on("far")));
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("aim at nothing on the panel", () => g.aim([380, 10]));
    matches("release off the element", g.lines);
    g.teardown();
  });

  test("a press that becomes a scroll", async () => {
    const g = await page(SCROLLER);
    await g.step("aim at #c", () => g.aim(g.on("c")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("hand moves 3 px up", () => g.aim(g.on("c", 75, 17)));
    await g.step("hand moves 30 px up", () => g.aim(g.on("c", 75, -10)));
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("ray stays", () => g.hands[0].frame());
    matches("a press that becomes a scroll", g.lines);
    g.teardown();
  });

  test("a press that becomes a drag and drop, taken", async () => {
    const g = await page(LISTS);
    await g.step("aim at #a", () => g.aim(g.on("a")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("hand carries it onto #b", () => g.aim(g.on("b")));
    await g.step("hand carries it onto #d", () => g.aim(g.on("d")));
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("hand moves on #a's old place", () => g.aim(g.on("a")));
    matches("a press that becomes a drag and drop, taken", g.lines);
    g.teardown();
  });

  test("a press that becomes a drag and drop, refused", async () => {
    const g = await page(LISTS, { accept: false });
    await g.step("aim at #a", () => g.aim(g.on("a")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("hand carries it onto #d", () => g.aim(g.on("d")));
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    matches("a press that becomes a drag and drop, refused", g.lines);
    g.teardown();
  });

  test("a captured press that becomes a drag and drop", async () => {
    const g = await page(LISTS, { accept: false, capture: true });
    await g.step("aim at #a", () => g.aim(g.on("a")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("hand carries it onto #d", () => g.aim(g.on("d")));
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("aim at #b", () => g.aim(g.on("b")));
    await g.step("ray stays", () => g.hands[0].frame());
    matches("a captured press that becomes a drag and drop", g.lines);
    g.teardown();
  });

  test("the grip", async () => {
    const g = await page(NEST);
    await g.step("aim at #icon", () => g.aim(g.on("icon")));
    await g.step("grip closes", () => g.hands[0].trigger("squeezestart"));
    await g.step("grip opens", () => g.hands[0].trigger("squeezeend"));
    await g.step("grip closes", () => g.hands[0].trigger("squeezestart"));
    await g.step("aim off the card", () => g.aim([380, 280]));
    await g.step("grip opens", () => g.hands[0].trigger("squeezeend"));
    matches("the grip", g.lines);
    g.teardown();
  });

  test("enter and leave across a nest", async () => {
    const g = await page(NEST);
    await g.step("aim at #card", () => g.aim(g.on("card", 150, 50)));
    await g.step("ray stays", () => g.hands[0].frame());
    await g.step("hand moves on #card", () => g.aim(g.on("card", 160, 50)));
    await g.step("aim at #icon", () => g.aim(g.on("icon")));
    await g.step("hand moves on #icon", () => g.aim(g.on("icon", 25, 20)));
    await g.step("aim at #card", () => g.aim(g.on("card", 150, 50)));
    await g.step("aim away", () => g.hands[0].turnAway());
    matches("enter and leave across a nest", g.lines);
    g.teardown();
  });

  test("an element removed before the commit", async () => {
    const g = await page(SCROLLER);
    await g.step("aim at #b", () => g.aim(g.on("b")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("page removes #b", () => g.elements.get("b")?.remove());
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("panel commits", () => drain());
    matches("an element removed before the commit", g.lines);
    g.teardown();
  });

  test("a move over an element removed before the commit", async () => {
    // The removed icon is still drawn until the commit, so the ray is still
    // on it. The move is the next clickable element's to send, as a press's
    // release is.
    const g = await page(NEST);
    await g.step("aim at #icon", () => g.aim(g.on("icon")));
    await g.step("page removes #icon", () => g.elements.get("icon")?.remove());
    await g.step("hand moves on #icon", () => g.aim(g.on("icon", 25, 20)));
    await g.step("panel commits", () => drain());
    matches("a move over an element removed before the commit", g.lines);
    g.teardown();
  });

  test("an element removed after the commit", async () => {
    const g = await page(SCROLLER);
    await g.step("aim at #b", () => g.aim(g.on("b")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("page removes #b, and the panel commits", async () => {
      g.elements.get("b")?.remove();
      await drain();
    });
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("ray stays", () => g.hands[0].frame());
    matches("an element removed after the commit", g.lines);
    g.teardown();
  });

  test("a cancelled press that outlives its row's registration", async () => {
    // The press ends with its release though the row it began on has let
    // go of its registration by then, so the mouse events the cancelled
    // `pointerdown` held back come back for the moves after it.
    const g = await page(SCROLLER, { cancel: true });
    await g.step("aim at #b", () => g.aim(g.on("b")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("page removes #b, and the panel commits", async () => {
      g.elements.get("b")?.remove();
      await drain();
    });
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("aim at #c", () => g.aim(g.on("c")));
    await g.step("hand moves on #c", () => g.aim(g.on("c", 30, 20)));
    matches("a cancelled press that outlives its row's registration", g.lines);
    g.teardown();
  });

  test("a row removed mid-scroll after the commit", async () => {
    // The case #454 fixed without a test: the scroll ends on the
    // controller's own release, whatever became of the row it began on.
    const g = await page(SCROLLER);
    await g.step("aim at #b", () => g.aim(g.on("b")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("hand moves 30 px", () => g.aim(g.on("b", 75, -10)));
    await g.step("page removes #b, and the panel commits", async () => {
      g.elements.get("b")?.remove();
      await drain();
    });
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("hand moves 30 px more", () => g.aim(g.on("b", 75, -40)));
    await g.step("ray stays", () => g.hands[0].frame());
    matches("a row removed mid-scroll after the commit", g.lines);
    g.teardown();
  });

  test("a controller disconnected mid-press", async () => {
    const g = await page(NEST);
    await g.step("aim at #icon", () => g.aim(g.on("icon")));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("hand disconnects", () => g.hands[0].disconnect());
    await g.step("a frame", () => g.hands[0].frame());
    matches("a controller disconnected mid-press", g.lines);
    g.teardown();
  });

  test("a second hand during a hold", async () => {
    const g = await page([...LEAF, { id: "far", style: POINTER, at: [200, 200, 100, 40] }]);
    await g.step("first hand aims at #leaf", () => g.aim(g.on("leaf")));
    await g.step("first trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("second hand aims at #leaf", () => g.aim(g.on("leaf", 80, 20), 1));
    await g.step("second trigger closes", () => g.hands[1].trigger("selectstart"));
    await g.step("second trigger opens", () => g.hands[1].trigger("selectend"));
    await g.step("second hand aims at #far", () => g.aim(g.on("far"), 1));
    await g.step("first trigger opens", () => g.hands[0].trigger("selectend"));
    matches("a second hand during a hold", g.lines);
    g.teardown();
  });

  test("a press on the top card of a pile", async () => {
    // Where all three overlap, the last card is on top, as on a page.
    const g = await page(PILE);
    await g.step("aim where the three overlap", () => g.aim([100, 70]));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    await g.step("aim where only #p1 and #p2 overlap", () => g.aim([60, 50]));
    await g.step("trigger closes", () => g.hands[0].trigger("selectstart"));
    await g.step("trigger opens", () => g.hands[0].trigger("selectend"));
    matches("a press on the top card of a pile", g.lines);
    g.teardown();
  });
});
