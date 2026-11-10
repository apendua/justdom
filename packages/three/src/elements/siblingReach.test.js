import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { siblingReachOf } from "./siblingReach.js";

/**
 * @param {string} selector
 * @returns {string[] | null}
 */
function reach(selector) {
  const names = siblingReachOf(selector);
  return names && [...names].sort();
}

describe("siblingReachOf", () => {
  test("a selector with no sibling combinator reaches no sibling, whatever it names", () => {
    assert.deepEqual(reach(".row[data-on] > .label"), []);
    assert.deepEqual(reach("#list .row:first-child[style*='x']"), []);
    assert.deepEqual(reach("li:has(.done)"), []);
    assert.deepEqual(reach(".chip::before"), []);
  });

  test("a sibling combinator gives every name in the selector", () => {
    assert.deepEqual(reach(".row[data-on] + .row"), ["class", "data-on"]);
    assert.deepEqual(reach("[data-open] ~ li"), ["data-open"]);
    assert.deepEqual(reach("#top + p"), ["id"]);
    assert.deepEqual(reach("li + li[aria-selected=true]"), ["aria-selected"]);
  });

  test("a combinator inside a pseudo-class's argument counts, and its names do", () => {
    assert.deepEqual(reach(".row:has(+ .row[data-on])"), ["class", "data-on"]);
    assert.deepEqual(reach("li:not([hidden] ~ li)"), ["hidden"]);
    assert.deepEqual(reach(":is(.a, [data-b]) ~ div"), ["class", "data-b"]);
    assert.deepEqual(reach("li:nth-child(2 of [data-x]) + li"), ["data-x"]);
  });

  test("the + of an An+B formula is no combinator", () => {
    assert.deepEqual(reach("li:nth-child(2n+1)[data-x]"), []);
    assert.deepEqual(reach("li:nth-last-of-type(-n + 3)"), []);
    assert.deepEqual(reach("li:nth-child(2n+1) ~ [data-x]"), ["data-x"]);
  });

  test("a combinator or a name inside a string or an attribute's value does not count", () => {
    assert.deepEqual(reach("[title='a + b']"), []);
    assert.deepEqual(reach('[data-x="~.y#z"]'), []);
    assert.deepEqual(reach("[class~=on]"), []);
    assert.deepEqual(reach("[class~=on] + li"), ["class"]);
    assert.deepEqual(reach("[data-a='.b'] + [data-c]"), ["data-a", "data-c"]);
  });

  test("attribute names are lowercased and lose their namespace and escapes", () => {
    assert.deepEqual(reach("[Data-On] + li"), ["data-on"]);
    assert.deepEqual(reach("[xlink|href] + li"), ["href"]);
    assert.deepEqual(reach("[*|lang] ~ p"), ["lang"]);
    assert.deepEqual(reach("[data\\:x] + li"), ["data:x"]);
    assert.deepEqual(reach("[ data-x = '1' ] + li"), ["data-x"]);
  });

  test("an escaped combinator, dot or hash is part of a name", () => {
    assert.deepEqual(reach(".a\\+b"), []);
    assert.deepEqual(reach(".w-1\\.5 > li"), []);
  });

  test("the structural and user-action pseudo-classes need no name", () => {
    assert.deepEqual(reach("li:first-child + li"), []);
    assert.deepEqual(reach("li:is(:hover, [data-xr-hover]) + li"), ["data-xr-hover"]);
    assert.deepEqual(reach(":root li:last-of-type ~ li:empty"), []);
  });

  test(":checked gives the attribute and the flag the portal writes for a click", () => {
    assert.deepEqual(reach("input:checked + label"), ["checked", "data-xr-checked"]);
    assert.deepEqual(reach("input:CHECKED ~ span"), ["checked", "data-xr-checked"]);
  });

  test("any other pseudo-class in a sibling selector reaches through every attribute", () => {
    assert.equal(reach("input:disabled + label"), null);
    assert.equal(reach("details:open ~ p"), null);
    assert.equal(reach("a:any-link + span"), null);
    assert.equal(reach(":lang(en) ~ p"), null);
  });

  test("an unknown pseudo-class without a sibling combinator reaches nothing", () => {
    assert.deepEqual(reach("input:disabled"), []);
  });

  test("a pseudo-element, in either spelling, is not a pseudo-class", () => {
    assert.deepEqual(reach("li + li::before"), []);
    assert.deepEqual(reach("li + li:after"), []);
    assert.deepEqual(reach("li ~ li::part(label)"), []);
    assert.deepEqual(reach("li + li::slotted(.x)"), []);
  });
});
