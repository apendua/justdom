import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { initialDropEffect, PanelDataTransfer, resolveOperation } from "./dataTransfer.js";

describe("PanelDataTransfer", () => {
  test("is written in dragstart, guarded while the drag is under way, read in drop", () => {
    const data = new PanelDataTransfer();
    data.setData("text/plain", "row-1");
    data.setData("Text", "row-2");
    data.setData("application/x-row", "7");
    assert.deepEqual(data.types, ["text/plain", "application/x-row"], "`Text` is `text/plain`");

    data.setMode("protected");
    assert.equal(data.getData("text/plain"), "", "a dragover sees no data");
    assert.deepEqual(data.types, ["text/plain", "application/x-row"], "but sees the types");
    data.setData("text/plain", "changed");
    data.clearData();

    data.setMode("readonly");
    assert.equal(data.getData("text"), "row-2", "a drop reads what dragstart wrote");
    data.clearData("text/plain");
    assert.equal(data.getData("text/plain"), "row-2", "and cannot change it");
  });

  test("hands out the first URL of a list for `URL`", () => {
    const data = new PanelDataTransfer();
    data.setData("text/uri-list", "# a comment\nhttps://apendua.dev/\nhttps://example.com/");
    assert.equal(data.getData("URL"), "https://apendua.dev/");
  });

  test("takes effectAllowed only in dragstart, and only a value it knows", () => {
    const data = new PanelDataTransfer();
    assert.equal(data.effectAllowed, "uninitialized");
    data.effectAllowed = "sideways";
    assert.equal(data.effectAllowed, "uninitialized");
    data.effectAllowed = "move";
    data.setMode("protected");
    data.effectAllowed = "copy";
    assert.equal(data.effectAllowed, "move");
  });

  test("takes a dropEffect in any mode, and only a value it knows", () => {
    const data = new PanelDataTransfer();
    data.setMode("protected");
    data.dropEffect = "move";
    data.dropEffect = "all";
    assert.equal(data.dropEffect, "move");
  });

  test("keeps the drag image only while it can be written", () => {
    const data = new PanelDataTransfer();
    const image = document.createElement("div");
    data.setDragImage(image, 4, 5);
    data.setMode("protected");
    data.setDragImage(document.createElement("div"), 0, 0);
    assert.deepEqual(data.getDragImage(), { element: image, x: 4, y: 5 });
  });
});

describe("drop effects", () => {
  test("a dragover starts from the first effect the source allows", () => {
    assert.equal(initialDropEffect("move"), "move");
    assert.equal(initialDropEffect("copyMove"), "copy");
    assert.equal(initialDropEffect("linkMove"), "link");
    assert.equal(initialDropEffect("uninitialized"), "copy");
    assert.equal(initialDropEffect("none"), "none");
  });

  test("an operation is what the target asked for, if the source allows it", () => {
    assert.equal(resolveOperation("move", "move"), "move");
    assert.equal(resolveOperation("copyMove", "move"), "move");
    assert.equal(resolveOperation("copy", "move"), "none");
    assert.equal(resolveOperation("all", "link"), "link");
    assert.equal(resolveOperation("none", "copy"), "none");
    assert.equal(resolveOperation("move", "none"), "none");
  });
});
