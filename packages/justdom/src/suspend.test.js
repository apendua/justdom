import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { just, map } from "@apendua/signal";
import { $, children, toMountable } from "./dom.js";
import { text } from "./text.js";
import { suspend, waitFor, withFallback } from "./suspend.js";

describe("withFallback", () => {
  it("builds the content once, and keeps it while the fallback is on screen", async () => {
    // The sharing this boundary is built on. Both the fallback and the content
    // are subscribed for the whole of a mounting — the content so that its
    // effects run and its promises are waited on, the fallback so that there is
    // something to look at meanwhile — and the content must be built once for
    // the two of them, not once each and not again when it is swapped in.
    let builds = 0;
    const ctx = suspend({}, () => $("p", [children(text`Loading...`)]));
    waitFor(ctx, new Promise((resolve) => setTimeout(resolve, 10)));
    const content = map(toMountable)(
      just(() => {
        builds += 1;
        return document.createElement("section");
      }, [children(text`Real content`)]),
    );

    const root = document.createElement("div");
    const subscription = just(root, [children(withFallback(ctx, content))]).subscribe();

    assert.strictEqual(root.querySelector("p")?.textContent, "Loading...");
    assert.strictEqual(builds, 1, "expected the content built once, behind the fallback");

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.strictEqual(root.querySelector("section")?.textContent, "Real content");
    assert.strictEqual(root.querySelector("p"), null, "expected the fallback swapped out");
    assert.strictEqual(builds, 1, "expected the content not rebuilt on the way in");

    subscription.unsubscribe();
  });
});
