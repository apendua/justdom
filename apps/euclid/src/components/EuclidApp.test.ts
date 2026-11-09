import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { children } from "justdom-core";
import { just } from "justdom-signal";
import { xrSession } from "justdom-xr/session";
import AppStore from "../store/App";
import { programLaidOut } from "./EuclidApp";
import Toolbar from "./Toolbar";

afterEach(() => {
  xrSession.set(null);
  document.body.replaceChildren();
});

/** The toolbar, mounted as the page mounts it, and its Code button. */
function mountToolbar(store: AppStore) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const subscription = just(host, [children(Toolbar(store))]).subscribe({});
  const codeButton = () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Code");
  return { codeButton, subscription };
}

describe("the Code button", () => {
  // jsdom reports every stylesheet it cannot parse, and it cannot parse the
  // nested rules (`&:hover`) the toolbar's buttons are written with. A
  // report is a line on stderr, which `rush build` counts as a warning.
  beforeEach(() => {
    const error = console.error;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes("Could not parse CSS stylesheet")) {
        error(...args);
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the program and hides it again", () => {
    const store = new AppStore();
    const { codeButton, subscription } = mountToolbar(store);
    expect(store.codeShown.get()).toBe(false);
    codeButton()?.click();
    expect(store.codeShown.get()).toBe(true);
    expect(codeButton()?.getAttribute("aria-pressed")).toBe("true");
    codeButton()?.click();
    expect(store.codeShown.get()).toBe(false);
    expect(codeButton()?.getAttribute("aria-pressed")).toBe("false");
    subscription.unsubscribe();
  });

  it("is not there in a session, which always shows the program", () => {
    const store = new AppStore();
    const { codeButton, subscription } = mountToolbar(store);
    expect(codeButton()).toBeDefined();
    xrSession.set({} as XRSession);
    expect(codeButton()).toBeUndefined();
    xrSession.set(null);
    expect(codeButton()).toBeDefined();
    subscription.unsubscribe();
  });
});

describe("the page's data-code", () => {
  it("says the program is shown when asked for, and in a session", () => {
    const store = new AppStore();
    const page = document.createElement("div");
    const subscription = just(page, [programLaidOut(store)]).subscribe({});
    expect(page.hasAttribute("data-code")).toBe(false);
    store.codeShown.set(true);
    expect(page.getAttribute("data-code")).toBe("shown");
    store.codeShown.set(false);
    xrSession.set({} as XRSession);
    expect(page.getAttribute("data-code")).toBe("shown");
    xrSession.set(null);
    expect(page.hasAttribute("data-code")).toBe(false);
    subscription.unsubscribe();
  });
});
