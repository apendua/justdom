import { afterEach, describe, expect, it } from "vitest";
import { followXRFocus } from "@apendua.dev/headset/focus";

// `followXRFocus` lives in `@apendua.dev/headset`, whose own tests run
// under plain `node --test` with no DOM, so it is tested here, beside a
// caller that has jsdom.

/** Let the observer's records arrive. */
const settle = () => new Promise((done) => setTimeout(done));

function page() {
  document.body.innerHTML = `
    <div id="root"><input id="a" /><input id="b" /><div id="box" tabindex="0"></div></div>
    <button id="outside">outside</button>`;
  const find = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  return {
    root: find("root"),
    a: find<HTMLInputElement>("a"),
    b: find<HTMLInputElement>("b"),
    box: find("box"),
    outside: find<HTMLButtonElement>("outside"),
  };
}

describe("followXRFocus", () => {
  let dispose = () => {};
  afterEach(() => dispose());

  it("focuses the field the mark arrives on, and blurs it when the mark goes", async () => {
    const { root, a } = page();
    dispose = followXRFocus(root);
    a.setAttribute("data-xr-focus", "");
    await settle();
    expect(document.activeElement).toBe(a);
    a.removeAttribute("data-xr-focus");
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("moves the focus with the mark from one field to the next", async () => {
    const { root, a, b } = page();
    dispose = followXRFocus(root);
    a.setAttribute("data-xr-focus", "");
    await settle();
    // In freedom's order: off the first, then on the second.
    a.removeAttribute("data-xr-focus");
    b.setAttribute("data-xr-focus", "");
    await settle();
    expect(document.activeElement).toBe(b);
  });

  it("leaves the focus where it went when the mark goes after it", async () => {
    const { root, a, outside } = page();
    dispose = followXRFocus(root);
    a.setAttribute("data-xr-focus", "");
    await settle();
    outside.focus();
    a.removeAttribute("data-xr-focus");
    await settle();
    expect(document.activeElement).toBe(outside);
  });

  it("leaves the mark alone when the focus leaves the field on its own", async () => {
    // The rule runs one way: the mark moves the focus, never the reverse.
    const { root, a, outside } = page();
    dispose = followXRFocus(root);
    a.setAttribute("data-xr-focus", "");
    await settle();
    outside.focus();
    await settle();
    expect(a.hasAttribute("data-xr-focus")).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it("ignores a mark on anything but an input", async () => {
    const { root, box } = page();
    dispose = followXRFocus(root);
    box.setAttribute("data-xr-focus", "");
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("stops following once disposed", async () => {
    const { root, a } = page();
    followXRFocus(root)();
    a.setAttribute("data-xr-focus", "");
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});
