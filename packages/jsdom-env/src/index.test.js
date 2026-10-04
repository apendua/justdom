import { test } from "node:test";
import assert from "node:assert/strict";
import { setupJsdom } from "./index.js";

setupJsdom();

test("a pointer event is a mouse event with a pointer's id and type", () => {
  const event = new PointerEvent("pointerdown", {
    bubbles: true,
    clientX: 10,
    pointerId: 2,
    pointerType: "mouse",
    isPrimary: true,
  });
  assert.ok(event instanceof MouseEvent);
  assert.equal(event.type, "pointerdown");
  assert.equal(event.bubbles, true);
  assert.equal(event.clientX, 10);
  assert.equal(event.pointerId, 2);
  assert.equal(event.pointerType, "mouse");
  assert.equal(event.isPrimary, true);
});

test("only the mouse's pointer can be captured", () => {
  const element = document.createElement("div");
  assert.ok(element instanceof Element);
  element.setPointerCapture(1);
  assert.equal(element.hasPointerCapture(1), true);
  element.releasePointerCapture(1);
  assert.equal(element.hasPointerCapture(1), false);
  assert.throws(() => element.setPointerCapture(2), { name: "NotFoundError" });
  assert.throws(() => element.releasePointerCapture(2), { name: "NotFoundError" });
  assert.equal(element.hasPointerCapture(2), false);
});

test("a second window has the stand-ins too", () => {
  const first = PointerEvent;
  setupJsdom();
  assert.notEqual(PointerEvent, first);
  assert.equal(new PointerEvent("pointerup", { pointerId: 3 }).pointerId, 3);
  assert.throws(() => document.createElement("div").setPointerCapture(3), {
    name: "NotFoundError",
  });
});
