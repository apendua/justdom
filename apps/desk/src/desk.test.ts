import { afterEach, describe, expect, it, vi } from "vitest";
import { mountDesk } from "./desk.js";
import { LOOKS, lookFromSearch } from "./looks.js";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("mountDesk", () => {
  it.each(LOOKS.map((look) => [look.name, look] as const))(
    "puts up %s with every zone its scene places",
    (_, look) => {
      vi.useFakeTimers();
      const desk = document.createElement("div");
      const style = document.createElement("style");
      document.body.append(desk);
      const mounted = mountDesk(desk, style, look, () => 1);
      expect(desk.dataset.look).toBe(look.id);
      expect([...mounted.elements.keys()]).toEqual(look.placements.map(({ id }) => id));
      for (const element of mounted.elements.values()) {
        expect(desk.contains(element)).toBe(true);
      }
      mounted.dispose();
      expect(desk.childElementCount).toBe(0);
    },
  );

  it("lets go of every window listener when a look is taken down", () => {
    // Swapping looks must not leave the last one's keyboard typing along.
    vi.useFakeTimers();
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const desk = document.createElement("div");
    document.body.append(desk);
    mountDesk(desk, document.createElement("style"), LOOKS[0], () => 1).dispose();
    const pairs = (spy: typeof added) => spy.mock.calls.map(([type, listener]) => [type, listener]);
    expect(pairs(added).length).toBeGreaterThan(0);
    expect(pairs(removed)).toEqual(expect.arrayContaining(pairs(added)));
    added.mockRestore();
    removed.mockRestore();
  });
});

describe("lookFromSearch", () => {
  it("opens the look the address names, and the first one otherwise", () => {
    expect(lookFromSearch("?look=paper").id).toBe("paper");
    expect(lookFromSearch("?look=ops&emulator").id).toBe("ops");
    expect(lookFromSearch("?look=nope").id).toBe("beige");
    expect(lookFromSearch("").id).toBe("beige");
  });
});
