import { afterEach, describe, expect, it, vi } from "vitest";
import { mountDesk } from "./desk.js";
import { LOOKS, lookFromSearch } from "./looks.js";
import photo from "../public/photo.svg?raw";

/** The SVG files in `public/` a look's markup names, by the `src` it uses. */
const PUBLIC_SVGS: Record<string, string> = { "photo.svg": photo };

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

describe("the photographs on the boards", () => {
  /**
   * The SVG behind each `<img>` a look shows, read from `public/` or from
   * its data URL.
   */
  const photographs = LOOKS.flatMap((look) =>
    [...new DOMParser().parseFromString(look.markup, "text/html").querySelectorAll("img")]
      .map((img) => img.getAttribute("src") ?? "")
      .filter((src) => src.endsWith(".svg") || src.startsWith("data:image/svg+xml"))
      .map((src) => {
        const svg = src.startsWith("data:")
          ? decodeURIComponent(src.slice(src.indexOf(",") + 1))
          : (PUBLIC_SVGS[src] ?? "");
        return [`${look.name}: ${src.slice(0, 40)}`, svg] as const;
      }),
  );

  it("are on the boards", () => {
    expect(photographs.length).toBeGreaterThan(0);
  });

  it.each(photographs)("%s says how big it is", (_, svg) => {
    // A session draws an `<img>` as a WebGL texture. An SVG with only a
    // `viewBox` has no size of its own, and Chrome on a laptop refuses to
    // upload one ("texSubImage2D: bad image data"), so the card shows no
    // picture in a session while the page shows it.
    const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    expect(root.localName).toBe("svg");
    expect(Number(root.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(root.getAttribute("height"))).toBeGreaterThan(0);
  });
});
