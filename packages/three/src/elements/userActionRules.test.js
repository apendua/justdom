import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  originalSelector,
  restoreUserActions,
  rewriteSelector,
  rewriteUserActions,
} from "./userActionRules.js";
import { forgetComputedStyles } from "../test/computedStyles.js";

describe("rewriteSelector", () => {
  test("names the flag beside each user-action pseudo-class", () => {
    assert.equal(rewriteSelector(".button:hover"), ".button:is(:hover, [data-xr-hover])");
    assert.equal(rewriteSelector("a:active"), "a:is(:active, [data-xr-active])");
    assert.equal(rewriteSelector("input:focus"), "input:is(:focus, [data-xr-focus])");
    assert.equal(
      rewriteSelector("input:focus-visible"),
      "input:is(:focus-visible, [data-xr-focus])",
    );
  });

  test("rewrites every selector of a list, and inside a negation", () => {
    assert.equal(
      rewriteSelector(".a:hover .b, .c:not(:hover)"),
      ".a:is(:hover, [data-xr-hover]) .b, .c:not(:is(:hover, [data-xr-hover]))",
    );
  });

  test("leaves what is not a user-action pseudo-class alone", () => {
    assert.equal(rewriteSelector(".a"), null);
    assert.equal(rewriteSelector(".a:focus-within"), null);
    assert.equal(rewriteSelector(".a:hovering"), null);
    assert.equal(rewriteSelector('[title=":hover"]'), null);
    assert.equal(rewriteSelector("[data-state=a\\:hover]"), null);
  });

  test("leaves a pseudo-class that follows a pseudo-element", () => {
    assert.equal(rewriteSelector("::-webkit-scrollbar-thumb:hover"), null);
    assert.equal(rewriteSelector("a:after:hover"), null);
    // The next compound starts afresh.
    assert.equal(
      rewriteSelector("a::before:hover, b:hover"),
      "a::before:hover, b:is(:hover, [data-xr-hover])",
    );
    // A pseudo-element after the pseudo-class is where it may be.
    assert.equal(rewriteSelector("a:hover::after"), "a:is(:hover, [data-xr-hover])::after");
  });
});

/**
 * @param {string} css
 * @returns {HTMLStyleElement}
 */
function addStyle(css) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

/**
 * @param {HTMLStyleElement} style
 * @returns {CSSStyleSheet}
 */
function sheetOf(style) {
  const sheet = style.sheet;
  assert.ok(sheet);
  return sheet;
}

describe("rewriteUserActions", () => {
  test("a :hover rule styles an element carrying the flag", () => {
    const style = addStyle(".ua-a:hover { color: rgb(255, 0, 0); }");
    const element = document.createElement("div");
    element.className = "ua-a";
    element.setAttribute("data-xr-hover", "");
    document.body.appendChild(element);
    try {
      assert.notEqual(window.getComputedStyle(element).color, "rgb(255, 0, 0)");
      rewriteUserActions([sheetOf(style)]);
      forgetComputedStyles();
      assert.equal(window.getComputedStyle(element).color, "rgb(255, 0, 0)");
    } finally {
      element.remove();
      style.remove();
    }
  });

  test("a negated :hover still matches an element nobody hovers", () => {
    const style = addStyle(".ua-b:not(:hover) { color: rgb(0, 0, 255); }");
    const element = document.createElement("div");
    element.className = "ua-b";
    document.body.appendChild(element);
    try {
      rewriteUserActions([sheetOf(style)]);
      assert.equal(window.getComputedStyle(element).color, "rgb(0, 0, 255)");
      element.setAttribute("data-xr-hover", "");
      assert.notEqual(window.getComputedStyle(element).color, "rgb(0, 0, 255)");
    } finally {
      element.remove();
      style.remove();
    }
  });

  test("a later rule of the same specificity still wins", () => {
    const style = addStyle(
      ".ua-c:hover { color: rgb(255, 0, 0); } .ua-c[disabled] { color: rgb(0, 128, 0); }",
    );
    const element = document.createElement("button");
    element.className = "ua-c";
    element.setAttribute("disabled", "");
    element.setAttribute("data-xr-hover", "");
    document.body.appendChild(element);
    try {
      rewriteUserActions([sheetOf(style)]);
      assert.equal(window.getComputedStyle(element).color, "rgb(0, 128, 0)");
    } finally {
      element.remove();
      style.remove();
    }
  });

  test("keeps every rule at its index, and rewrites inside @media", () => {
    const style = addStyle(
      ".ua-d { color: red; } @media screen { .ua-d:hover { color: blue; } } .ua-e { color: green; }",
    );
    const sheet = sheetOf(style);
    try {
      const rewritten = rewriteUserActions([sheet]);
      assert.equal(rewritten.length, 1);
      assert.equal(sheet.cssRules.length, 3);
      // What a CSS-in-JS library deletes by index is still the rule it means.
      sheet.deleteRule(2);
      assert.equal(sheet.cssRules.length, 2);
      assert.equal(/** @type {CSSStyleRule} */ (sheet.cssRules[0]).selectorText, ".ua-d");
      const media = /** @type {CSSMediaRule} */ (sheet.cssRules[1]);
      assert.equal(
        /** @type {CSSStyleRule} */ (media.cssRules[0]).selectorText,
        ".ua-d:is(:hover, [data-xr-hover])",
      );
    } finally {
      style.remove();
    }
  });

  test("rewrites a rule once, and puts back the page's own text", () => {
    const style = addStyle(".ua-f:hover { color: red; }");
    const sheet = sheetOf(style);
    const rule = /** @type {CSSStyleRule} */ (sheet.cssRules[0]);
    try {
      assert.equal(rewriteUserActions([sheet]).length, 1);
      assert.equal(rewriteUserActions([sheet]).length, 0);
      assert.equal(rule.selectorText, ".ua-f:is(:hover, [data-xr-hover])");
      restoreUserActions([sheet]);
      assert.equal(rule.selectorText, ".ua-f:hover");
      // And it can be rewritten again for the next panel.
      assert.equal(rewriteUserActions([sheet]).length, 1);
      restoreUserActions([sheet]);
    } finally {
      style.remove();
    }
  });

  test("rewrites a rule the page edited after the rewrite", () => {
    const style = addStyle(".ua-g:hover { color: red; }");
    const sheet = sheetOf(style);
    const rule = /** @type {CSSStyleRule} */ (sheet.cssRules[0]);
    try {
      rewriteUserActions([sheet]);
      // As the developer tools do, on the rule object the sheet keeps.
      rule.selectorText = ".ua-h:hover";
      assert.deepEqual(rewriteUserActions([sheet]), [rule]);
      assert.equal(rule.selectorText, ".ua-h:is(:hover, [data-xr-hover])");
      assert.equal(originalSelector(rule), ".ua-h:hover");
      restoreUserActions([sheet]);
      assert.equal(rule.selectorText, ".ua-h:hover");
    } finally {
      style.remove();
    }
  });

  test("leaves the page's edit when it puts the rules back", () => {
    const style = addStyle(".ua-i:hover { color: red; }");
    const sheet = sheetOf(style);
    const rule = /** @type {CSSStyleRule} */ (sheet.cssRules[0]);
    try {
      rewriteUserActions([sheet]);
      rule.selectorText = ".ua-j";
      assert.equal(originalSelector(rule), ".ua-j");
      restoreUserActions([sheet]);
      assert.equal(rule.selectorText, ".ua-j");
    } finally {
      style.remove();
    }
  });
});
