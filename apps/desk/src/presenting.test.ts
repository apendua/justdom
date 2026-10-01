import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read off the disk: vitest hands a stylesheet import, `?raw` included, over
// empty.
const css = readFileSync(join(import.meta.dirname, "index.css"), "utf8");
const html = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");

/**
 * The rules in the sheet that set `transform` on `element`, with whether each
 * is `!important`. jsdom computes no `transform`, so the cascade is read off
 * the rules themselves.
 */
function transformRules(sheet: CSSStyleSheet, element: Element) {
  return [...sheet.cssRules]
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
    .filter(
      (rule) => rule.style.getPropertyValue("transform") && element.matches(rule.selectorText),
    )
    .map((rule) => ({
      selector: rule.selectorText,
      value: rule.style.getPropertyValue("transform"),
      important: rule.style.getPropertyPriority("transform") === "important",
    }));
}

describe("html[data-presenting]", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-presenting");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("takes the tilt off every zone, however specific its own rule is", () => {
    // A zone's tilt is set by its id, `#charts { transform: … }`, which is
    // more specific than any rule written for `.zone`. The override has to
    // win anyway, or the scene mirrors the zone measured under its tilt.
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    document.documentElement.setAttribute("data-presenting", "");
    const sheet = style.sheet as CSSStyleSheet;

    const zones = [...document.querySelectorAll<HTMLElement>(".zone")];
    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) {
      const rules = transformRules(sheet, zone);
      const winners = rules.filter((rule) => rule.important);
      expect(
        winners.map((rule) => rule.value),
        zone.id,
      ).toEqual(["none"]);
    }
  });
});
