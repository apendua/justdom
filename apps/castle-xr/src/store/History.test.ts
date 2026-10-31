import { beforeEach, describe, expect, it } from "vitest";
import History from "./History.js";

describe("History", () => {
  let history: History;
  let log: string[];

  const change = (name: string) => ({
    undo: () => log.push(`-${name}`),
    redo: () => log.push(`+${name}`),
  });

  beforeEach(() => {
    history = new History();
    log = [];
  });

  it("has nothing to take back to begin with", () => {
    expect(history.canUndoSignal.get()).toBe(false);
    expect(history.canRedoSignal.get()).toBe(false);
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
    expect(log).toEqual([]);
  });

  it("takes changes back in the order they were made", () => {
    history.record(change("a"));
    history.record(change("b"));
    history.undo();
    history.undo();
    expect(log).toEqual(["-b", "-a"]);
    expect(history.canUndoSignal.get()).toBe(false);
    expect(history.canRedoSignal.get()).toBe(true);
  });

  it("puts them back in the order they were taken", () => {
    history.record(change("a"));
    history.record(change("b"));
    history.undo();
    history.undo();
    log = [];
    history.redo();
    history.redo();
    expect(log).toEqual(["+a", "+b"]);
    expect(history.canRedoSignal.get()).toBe(false);
  });

  it("drops what was taken back once something new is done", () => {
    history.record(change("a"));
    history.undo();
    expect(history.canRedoSignal.get()).toBe(true);
    history.record(change("b"));
    expect(history.canRedoSignal.get()).toBe(false);
    expect(history.redo()).toBe(false);
  });

  it("forgets the oldest changes rather than growing without end", () => {
    for (let i = 0; i < 250; i++) {
      history.record(change(String(i)));
    }
    let count = 0;
    while (history.undo()) {
      count += 1;
    }
    expect(count).toBe(200);
    // The most recent change is the first one taken back.
    expect(log[0]).toBe("-249");
  });

  it("goes quiet when cleared", () => {
    history.record(change("a"));
    history.undo();
    history.clear();
    expect(history.canUndoSignal.get()).toBe(false);
    expect(history.canRedoSignal.get()).toBe(false);
  });
});
