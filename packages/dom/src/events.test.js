import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { on, just } from "@apendua.dev/signal";

describe("DOM events", () => {
  it("should subscribe to DOM event using on operator", () => {
    const spy = mock.fn();
    const element = document.createElement("div");
    const subscription = just(element, [
      on("click", (e) => {
        spy(e);
      }),
    ]).subscribe();
    element.click();
    subscription.unsubscribe();
    element.click(); // should not trigger the spy
    assert.strictEqual(spy.mock.calls.length, 1);
    assert.ok(spy.mock.calls[0].arguments[0] instanceof MouseEvent);
  });
});
