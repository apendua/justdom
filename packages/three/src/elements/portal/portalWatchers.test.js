/**
 * What a panel does when the page under it changes, as `portalWatchers.js`
 * does it: mutations, scroll, animations, and the restyles that attributes
 * and stylesheets cause.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived, Effect, Signal, toObservable, UpdateChannel, withChannel } from "justdom-signal";
import { $, attr, children, className, stylesheet } from "justdom-core";
import { InteractionContext, InteractionManager } from "../../interactions.js";
import { BUSY_ATTRIBUTE, LOADING_ATTRIBUTE } from "../mirror/mutationRules.js";
import { getComputedStyleCached, getTransformStyle } from "../mirror/styleReads.js";
import { resetMeasuringRangeForTests } from "../mirror/textLayout.js";
import { getPortalRoot } from "./portalRoot.js";
import { syntheticEvent } from "../../test/events.js";

import { enableOutlinesMode, outlinesReport } from "../dev/outlines.js";
import { createPortal, drain, pump, settle } from "../../test/portalHarness.js";

describe("createPortal", () => {
  test("mirroring a change asks for the rays to be cast again", async () => {
    const manager = new InteractionManager();
    let updates = 0;
    const originalUpdate = manager.updateIntersections.bind(manager);
    manager.updateIntersections = () => {
      updates += 1;
      originalUpdate();
    };
    const ctx = InteractionContext.set({}, manager);

    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    // A hand pointing at the button that opened a menu is not moving, and the
    // hit is only recomputed when it does — so a menu appearing underneath it
    // would go unnoticed until the player twitched.
    assert.ok(updates > 0, "the mirrored mutation invalidated the hits");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a scroll is one translation of the content group, and measures nothing", async () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    const parent = new THREE.Group();
    portal.addTo(parent);

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        $("div", [
          attr("class", () => "list"),
          attr("style", () => "overflow: hidden"),
          children($("div"), $("div"), $("div")),
        ]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const container = containers[containers.length - 1];
    const scroller = /** @type {HTMLElement} */ (container.querySelector(".list"));
    assert.ok(scroller);
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop });

    // containerObject carries the blocker mesh and the root element's
    // object; each element object carries its content group first, then its
    // own quad.
    const containerObject = parent.children[0];
    const rootObject = containerObject.children.find((child) => !(child instanceof THREE.Mesh));
    assert.ok(rootObject);
    const scrollerObject = /** @type {THREE.Object3D} */ (rootObject.children[0].children[0]);
    const contentGroup = scrollerObject.children[0];
    assert.equal(contentGroup.children.length, 3, "the rows ride in the content group");
    assert.deepEqual([contentGroup.position.x, contentGroup.position.y], [0, 0]);

    // The regression this pins down: scrolling used to re-measure the
    // scroller's whole subtree, a cost linear in the length of the list.
    // Now the stored geometry is scroll-invariant, so a scroll reads nothing
    // back from the DOM — it is one signal write and one translation.
    // Off `window`, because that is where jsdom keeps the constructor — the
    // `Element` global is not defined under the test setup.
    const originalGetRect = window.Element.prototype.getBoundingClientRect;
    const originalCreateRange = document.createRange.bind(document);
    let rectReads = 0;
    let rangeMeasurements = 0;
    window.Element.prototype.getBoundingClientRect = function () {
      rectReads += 1;
      return originalGetRect.call(this);
    };
    // One range serves every measurement now, so a measurement is a node
    // being selected on it, not a range being made.
    resetMeasuringRangeForTests();
    document.createRange = () => {
      const range = originalCreateRange();
      const select = range.selectNodeContents.bind(range);
      range.selectNodeContents = (node) => {
        rangeMeasurements += 1;
        select(node);
      };
      return range;
    };
    try {
      scrollTop = 40;
      scroller.dispatchEvent(new Event("scroll"));
      // The scroll settles in the event that carried it: the content group
      // has moved before the handler returns, and so has everything else the
      // offset decides — clipping, culling — because a scroll flushes the
      // panel's channel rather than waiting for the pump. Content that slid
      // this frame with clipping catching up over the next several is the
      // tear that makes a scroller unusable, and no budget is worth it.
      assert.deepEqual(
        [contentGroup.position.x, contentGroup.position.y],
        [0, -40],
        "the content slides by exactly the offset, synchronously",
      );
      assert.equal(rectReads, 0, "no rects are read back");
      assert.equal(rangeMeasurements, 0, "no text is re-measured");
    } finally {
      window.Element.prototype.getBoundingClientRect = originalGetRect;
      document.createRange = originalCreateRange;
      resetMeasuringRangeForTests();
    }

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("an animation of nothing inherited restyles the element, not what is on it", async () => {
    // The clock and the mirror each have tests of their own for this; what
    // this one pins is the wire between them. A card turning under a
    // transform re-reads the card's transform and neither style; a
    // background fading restyles the card and not the label on it; a colour
    // transition, which the label inherits, restyles both.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());
    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const subscription = $("div", [children($("div", []))]).subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const card = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const label = /** @type {HTMLElement} */ (card.firstElementChild);
    // Where a card is mid-turn: a transform of its own, and none on the
    // label. The clock compares the two to rule out a label that inherits
    // the transform explicitly, and two unset values would compare equal.
    card.style.transform = "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)";
    // And a background of its own, which the label does not share, for the
    // same reason.
    card.style.backgroundColor = "rgb(10, 20, 30)";
    await pump();
    // The turn as the browser reports it frame by frame. jsdom has no
    // transitions, and writing the style would be a mutation.
    let turn = 0;
    const getComputedStyle = window.getComputedStyle;
    window.getComputedStyle = (element, pseudoElement) => {
      const style = getComputedStyle.call(window, element, pseudoElement);
      if (element !== card) {
        return style;
      }
      return new Proxy(style, {
        get(target, key) {
          if (key === "transform") {
            return `matrix(0.996, 0.087, -0.087, 0.996, ${turn}, 0)`;
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const reads = { transform: 0, card: 0, label: 0 };
    const holders = [
      new Effect(() => {
        reads.transform += 1;
        getTransformStyle(card);
      }),
      new Effect(() => {
        reads.card += 1;
        getComputedStyleCached(card);
      }),
      new Effect(() => {
        reads.label += 1;
        getComputedStyleCached(label);
      }),
    ];
    assert.deepEqual(reads, { transform: 1, card: 1, label: 1 });

    /** @param {string} type @param {string} propertyName */
    const transition = (type, propertyName) =>
      card.dispatchEvent(syntheticEvent(type, { propertyName }));

    try {
      transition("transitionrun", "transform");
      turn = 1;
      await pump();
      assert.ok(reads.transform > 1, "the card's transform is read again while it turns");
      assert.equal(reads.card, 1, "the rest of the card's style is not");
      assert.equal(reads.label, 1, "nor the label's on it");
      transition("transitionend", "transform");
      await pump();

      transition("transitionrun", "background-color");
      await pump();
      assert.ok(reads.card > 1, "the card restyles while its background fades");
      assert.equal(reads.label, 1, "the label on it does not");
      transition("transitionend", "background-color");
      await pump();

      const before = reads.label;
      transition("transitionrun", "color");
      await pump();
      assert.ok(reads.label > before, "a colour reaches the label, which inherits it");
    } finally {
      // Ended whichever way the test went, or the clock goes on asking for
      // frames every test after this one would have to flush.
      transition("transitionend", "transform");
      transition("transitionend", "background-color");
      transition("transitionend", "color");
      await pump();
      window.getComputedStyle = getComputedStyle;
      holders.forEach((effect) => effect.dispose());
      subscription.unsubscribe();
      portal.disconnect();
    }
  });

  test("re-writing an attribute with the value it already has invalidates nothing", async () => {
    // The hover handlers write `data-xr-*` back on every pointer event, and
    // the observer reports every write. The mirror compares against the
    // record's oldValue, so only the first write — the actual change — costs
    // a restyle.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "hovered")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("hovered"));
    assert.ok(element);

    let reads = 0;
    // In a channel of the same order as the portal's, because the style
    // cache it reads belongs to the panel's channel — a default-channel
    // reader of panel state is a backwards edge, and `Derived` would
    // rightly warn about it.
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () =>
        new Derived(() => {
          reads += 1;
          return getComputedStyleCached(element).cursor;
        }),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    dependent.get();
    assert.equal(reads, 1);

    element.dataset.xrHover = "true";
    await pump();
    assert.equal(reads, 2, "the first write is a change");

    element.dataset.xrHover = "true";
    await pump();
    assert.equal(reads, 2, "the second is not");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("an attribute the app's own stylesheet selects on restyles the element", async () => {
    // A button greyed out through `[data-off]`: an attribute no part of the
    // portal knows the name of, written after the mount.
    const style = document.createElement("style");
    style.textContent = "#switch[data-off] { cursor: not-allowed; }";
    document.head.appendChild(style);
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "switch")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("switch"));
    assert.ok(element);
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () => new Derived(() => getComputedStyleCached(element).cursor),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    assert.notEqual(dependent.get(), "not-allowed");

    element.setAttribute("data-off", "");
    await pump();
    assert.equal(dependent.get(), "not-allowed", "switched off");

    element.removeAttribute("data-off");
    await pump();
    assert.notEqual(dependent.get(), "not-allowed", "and on again");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
    style.remove();
  });

  test("the portal's loading and busy flags on its container restyle nothing", async () => {
    // The container is above every element in the panel, so an author's
    // attribute there would restyle all of them. The portal writes the
    // loading flag twice a mount and the busy flag twice an animation, and
    // no stylesheet is meant to select on either.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "inside")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("inside"));
    const containerElement = getPortalRoot(element);
    assert.ok(containerElement);

    let reads = 0;
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () =>
        new Derived(() => {
          reads += 1;
          return getComputedStyleCached(element).cursor;
        }),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    dependent.get();
    assert.equal(reads, 1);

    for (const flag of [LOADING_ATTRIBUTE, BUSY_ATTRIBUTE]) {
      containerElement.setAttribute(flag, "");
      await pump();
      containerElement.removeAttribute(flag);
      await pump();
      assert.equal(reads, 1, `neither write of ${flag} reached the element`);
    }

    containerElement.setAttribute("data-anything-else", "");
    await pump();
    assert.equal(reads, 2, "where any other attribute there does");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a sheet for one class restyles the panel that wears it and no other", async () => {
    // A keyboard that opens brings its styling library's sheets with it,
    // each a rule for a class only the keyboard wears. They restyled and
    // re-measured every panel on the page, which in outlines mode is every
    // element going dotted and in a headset a frame missed. Read here
    // through the outlines' counts: the panel that does not wear the class
    // is not read again at all, and the one that does is.
    const manager = new InteractionManager();
    const plainRoot = document.createElement("div");
    const rows = Array.from({ length: 4 }, (_, i) => {
      const row = document.createElement("div");
      row.id = `plain${i}`;
      return row;
    });
    plainRoot.append(...rows);
    const boardRoot = document.createElement("div");
    const dressed = document.createElement("div");
    dressed.id = "dressed";
    dressed.className = "kb_dressed";
    boardRoot.append(dressed);
    document.body.append(plainRoot, boardRoot);
    const plain = createPortal(InteractionContext.set({}, manager), { root: plainRoot });
    const board = createPortal(InteractionContext.set({}, manager), { root: boardRoot });
    plain.addTo(new THREE.Group());
    board.addTo(new THREE.Group());
    await settle(plain);
    await settle(board);
    const off = enableOutlinesMode();
    const style = document.createElement("style");
    try {
      style.innerHTML = ".kb_dressed { padding: 4px; color: rgb(9, 8, 7); }";
      document.head.append(style);
      await drain();
      const report = outlinesReport(Infinity);
      const ids = report.map((row) => row.element.split("#").pop());
      assert.ok(ids.includes("dressed"), `the dressed box was restyled, among ${ids}`);
      for (const row of rows) {
        assert.ok(!ids.includes(row.id), `${row.id} was not read again, among ${ids}`);
      }
    } finally {
      off();
      style.remove();
      await drain();
      plain.disconnect();
      board.disconnect();
      plainRoot.remove();
      boardRoot.remove();
    }
  });

  test("a sheet for a class worn before the panel restyles the whole panel", async () => {
    // `.toolbar ~ div` starts from a class nothing in the panel wears, and
    // still reaches the panel's root, a later sibling of the toolbar, and
    // through inheritance everything in it.
    const toolbar = document.createElement("div");
    toolbar.className = "kb_toolbar";
    const root = document.createElement("div");
    const label = document.createElement("div");
    label.id = "under";
    root.append(label);
    document.body.append(toolbar, root);
    const portal = createPortal(InteractionContext.set({}, new InteractionManager()), { root });
    portal.addTo(new THREE.Group());
    await settle(portal);
    const off = enableOutlinesMode();
    const style = document.createElement("style");
    try {
      style.innerHTML = ".kb_toolbar ~ div { color: rgb(9, 8, 7); }";
      document.head.append(style);
      await drain();
      const ids = outlinesReport(Infinity).map((row) => row.element.split("#").pop());
      assert.ok(ids.includes("under"), `the label under the root was restyled, among ${ids}`);
    } finally {
      off();
      style.remove();
      await drain();
      portal.disconnect();
      root.remove();
      toolbar.remove();
    }
  });

  test("a rule rewritten behind a stable class name restyles the panel", async () => {
    // What a styling library that hands out class names does when the value
    // inside one of its templates changes: it rewrites the rule in the head
    // and leaves the `class` attribute exactly as it was. That is the whole
    // point of the stable name — one attribute across a lifetime of style
    // updates — and it means the panel's own subtree, which is all the
    // observer watches, does not move by so much as a character.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    const color = Signal.of("rgb(1, 2, 3)");
    const card = className`
      background-color: ${toObservable(color)};
    `;

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "card"), attr("class", card)]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("card"));
    assert.ok(element);
    const classBefore = element.getAttribute("class");

    let reads = 0;
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () =>
        new Derived(() => {
          reads += 1;
          return getComputedStyleCached(element).backgroundColor;
        }),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    assert.equal(dependent.get(), "rgb(1, 2, 3)");
    assert.equal(reads, 1);

    color.set("rgb(4, 5, 6)");
    await pump();

    assert.equal(
      element.getAttribute("class"),
      classBefore,
      "the class attribute is not what changed",
    );
    assert.equal(dependent.get(), "rgb(4, 5, 6)", "the panel wears the colour the rule now says");
    assert.equal(reads, 2, "and read it once more, not once per element in the head");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a head mutation that is not a stylesheet restyles nothing", async () => {
    // The head is a busy place — a title, a meta tag, a preload hint — and a
    // whole-panel restyle is far too expensive to spend on any of them.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "plain")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("plain"));
    assert.ok(element);

    let reads = 0;
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () =>
        new Derived(() => {
          reads += 1;
          return getComputedStyleCached(element).backgroundColor;
        }),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    dependent.get();
    assert.equal(reads, 1);

    const meta = document.createElement("meta");
    meta.setAttribute("name", "description");
    document.head.appendChild(meta);
    await pump();
    assert.equal(reads, 1, "a meta tag says nothing about how the panel looks");

    meta.remove();
    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a stylesheet arriving after the panel, and leaving again, both reach it", async () => {
    // The other half of the same event, and the other tag: `stylesheet`
    // writes whole rules rather than the body of one, and a sheet of them
    // can be mounted and unmounted while the panel it dresses stands still.
    // A component whose styles are subscribed alongside it is exactly that.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children($("div", [attr("id", () => "late"), attr("class", () => "late")])),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("late"));
    assert.ok(element);

    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () => new Derived(() => getComputedStyleCached(element).backgroundColor),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    assert.equal(dependent.get(), "rgba(0, 0, 0, 0)", "nothing dresses it yet");

    const sheet = stylesheet`
      .late {
        background-color: rgb(7, 8, 9);
      }
    `;
    const sheetSubscription = sheet.subscribe(() => {});
    await pump();
    assert.equal(dependent.get(), "rgb(7, 8, 9)", "the sheet landed on a panel already standing");

    sheetSubscription.unsubscribe();
    await pump();
    assert.equal(dependent.get(), "rgba(0, 0, 0, 0)", "and the rule left with it");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });
});
