import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read off the disk: vitest hands a stylesheet import, `?raw` included, over
// empty. Every look is the shared sheet and its own, around its own markup.
const read = (path: string) => readFileSync(join(import.meta.dirname, path), "utf8");
const shared = read("index.css");
const LOOKS = ["beige", "ops", "paper"];

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

  it.each(LOOKS)(
    "takes the tilt off every zone of %s, however specific its own rule is",
    (look) => {
      // A zone's tilt is set by its id, `#charts { transform: … }`, which is
      // more specific than any rule written for `.zone`. The override has to
      // win anyway, or the scene mirrors the zone measured under its tilt.
      const style = document.createElement("style");
      style.textContent = shared + read(`looks/${look}.css`);
      document.head.appendChild(style);
      document.body.innerHTML = read(`looks/${look}.html`);
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
    },
  );
});
