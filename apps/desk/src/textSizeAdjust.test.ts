import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read off the disk, as `presenting.test.ts` does: vitest hands a stylesheet
// import over empty.
const shared = readFileSync(join(import.meta.dirname, "index.css"), "utf8");

describe("index.css", () => {
  it("turns off Safari's text autosizing for the whole page", () => {
    // Safari on an iPhone lays the monitor's text out bigger than its
    // computed `font-size`, which is what justdom-three draws and measures
    // the reveal against. jsdom computes neither property, so the rule is
    // read off the sheet.
    const style = document.createElement("style");
    style.textContent = shared;
    document.head.appendChild(style);
    const rules = [...(style.sheet as CSSStyleSheet).cssRules].filter(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && document.documentElement.matches(rule.selectorText),
    );
    const values = (property: string) =>
      rules.map((rule) => rule.style.getPropertyValue(property)).filter(Boolean);
    expect(values("-webkit-text-size-adjust")).toEqual(["none"]);
    expect(values("text-size-adjust")).toEqual(["none"]);
    style.remove();
  });
});
