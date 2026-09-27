import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { children } from "@apendua/justdom";
import { just, Signal } from "@apendua/signal";
import { dropdown } from "./dropdown.js";

/**
 * @import {Mountable} from "@apendua/justdom";
 */

/** Class names as a panel would supply them: one observable per part. */
const classes = {
  root: just("root"),
  trigger: just("trigger"),
  caret: just("caret"),
  menu: just("menu"),
  option: just("option"),
  optionSelected: just("selected"),
};

/**
 * Mounts a widget into the document and hands back its root element, plus the
 * teardown. Nothing here is portal-specific: a dropdown is ordinary DOM, which
 * is the whole reason it can be projected into a scene at all.
 *
 * @param {import("@apendua/signal").Subscribable<Mountable>} tree
 */
function mount(tree) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const subscription = just(host, [children(tree)]).subscribe();
  const root = /** @type {HTMLElement} */ (host.firstElementChild);
  return {
    root,
    cleanup: () => {
      subscription.unsubscribe();
      host.remove();
    },
  };
}

/** @param {Element | null | undefined} element */
function click(element) {
  assert.ok(element instanceof HTMLElement, "expected an element to click");
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/** @param {HTMLElement} root */
const trigger = (root) => root.querySelector(".trigger");

/** @param {HTMLElement} root */
const menu = (root) => root.querySelector(".menu");

/** @param {HTMLElement} root */
const options = (root) => [...root.querySelectorAll(".option")];

const OPTIONS = [
  { value: "a", label: "Speakers" },
  { value: "b", label: "Headphones" },
];

describe("dropdown", () => {
  test("names what is chosen, and falls back to the placeholder", () => {
    const selected = Signal.of("");
    const { root, cleanup } = mount(
      dropdown({
        options: OPTIONS,
        classes,
        placeholder: "Nothing chosen",
        selected: () => selected.get(),
        onSelect: () => {},
      }),
    );

    assert.match(root.textContent ?? "", /Nothing chosen/);

    // Chosen from somewhere else entirely — the scene's own state moving, with
    // nothing here touched.
    selected.set("b");
    assert.match(root.textContent ?? "", /Headphones/);

    cleanup();
  });

  test("mounts and unmounts the menu rather than hiding it", () => {
    const { root, cleanup } = mount(
      dropdown({ options: OPTIONS, classes, selected: () => "a", onSelect: () => {} }),
    );

    // Not merely hidden: a portal re-measures when the tree changes and not
    // when an attribute does, so a menu that toggled `display` would never
    // reach the scene.
    assert.equal(menu(root), null, "shut to begin with");

    click(trigger(root));
    assert.ok(menu(root), "opens on the trigger");
    assert.deepEqual(
      options(root).map((option) => option.textContent),
      ["Speakers", "Headphones"],
    );

    click(trigger(root));
    assert.equal(menu(root), null, "and shuts again");

    cleanup();
  });

  test("marks the chosen row, and reports the one that is picked", () => {
    /** @type {string[]} */
    const picked = [];
    const selected = Signal.of("a");
    const { root, cleanup } = mount(
      dropdown({
        options: OPTIONS,
        classes,
        selected: () => selected.get(),
        onSelect: (value) => {
          picked.push(value);
          selected.set(value);
        },
      }),
    );

    click(trigger(root));
    assert.deepEqual(
      options(root).map((option) => option.className.split(" ").includes("selected")),
      [true, false],
    );

    click(options(root)[1]);

    assert.deepEqual(picked, ["b"]);
    assert.equal(menu(root), null, "choosing shuts the menu");
    assert.match(root.textContent ?? "", /Headphones/);

    cleanup();
  });

  test("follows a list that changes under it", () => {
    const available = Signal.of(OPTIONS);
    const { root, cleanup } = mount(
      dropdown({
        options: () => available.get(),
        classes,
        selected: () => "a",
        onSelect: () => {},
      }),
    );

    click(trigger(root));
    assert.equal(options(root).length, 2);

    // A device pulled out while its menu is open. The rows follow without the
    // menu being closed and re-opened, which is the whole point of taking the
    // options as a getter.
    available.set(OPTIONS.slice(0, 1));
    assert.deepEqual(
      options(root).map((option) => option.textContent),
      ["Speakers"],
    );

    cleanup();
  });

  test("closes when the click lands elsewhere, and not when it lands inside", () => {
    const { root, cleanup } = mount(
      dropdown({ options: OPTIONS, classes, selected: () => "a", onSelect: () => {} }),
    );

    click(trigger(root));
    assert.ok(menu(root), "open");

    // Off a portal the scope is the document, which is where a flat page's
    // clicks arrive; in a portal it is the panel, so that the emulator's own
    // controls cannot close a menu from under the ray reaching for it.
    click(menu(root));
    assert.ok(menu(root), "a click inside the menu leaves it open");

    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    click(elsewhere);
    assert.equal(menu(root), null, "a click outside shuts it");
    elsewhere.remove();

    cleanup();
  });

  test("a menu open when its element becomes a panel is scoped to the panel from then on", () => {
    // The page mounted this dropdown long before any session: a flat app
    // that adds an immersive session mirrors the element it already shows,
    // and the portal marks that element `data-xr-portal` when it takes it
    // and unmarks it when it lets go. The mark here is set by hand for
    // exactly that reason — it is the whole of what the widget looks at, so
    // the test is about the widget's answer and not the portal's machinery.
    const { root, cleanup } = mount(
      dropdown({ options: OPTIONS, classes, selected: () => "a", onSelect: () => {} }),
    );
    const panel = /** @type {HTMLElement} */ (root.parentElement);
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);

    click(trigger(root));
    assert.ok(menu(root), "open, on a page with no panel anywhere");

    // The session begins: the element the menu is in is now a panel.
    panel.setAttribute("data-xr-portal", "");

    // The emulator's click, on the page around the scene. Had the menu kept
    // the scope it opened with — the document — this would have closed it
    // from under the ray reaching for it.
    click(elsewhere);
    assert.ok(menu(root), "a click on the page around the panel is not elsewhere");

    // The panel's own background, which is what a ray landing beside the menu
    // reports.
    click(panel);
    assert.equal(menu(root), null, "a click on the panel is");

    // The session ends with the menu open again: the mark comes off, and the
    // page's clicks count once more.
    click(trigger(root));
    assert.ok(menu(root), "open again");
    panel.removeAttribute("data-xr-portal");
    click(elsewhere);
    assert.equal(menu(root), null, "a click on the page shuts it once the panel is gone");

    elsewhere.remove();
    cleanup();
  });
});
