import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpret, revealedCount, Terminal } from "./terminal.js";
import { PROGRAMS } from "./programs.js";

describe("interpret", () => {
  it("lists the commands and the disks", () => {
    expect(interpret("help")).toEqual({
      kind: "print",
      text: expect.stringContaining("LOAD <NAME>"),
    });
    expect(interpret("DIR")).toEqual({ kind: "print", text: Object.keys(PROGRAMS).join("\n") });
  });

  it("loads a disk by name, quoted or not, in any case", () => {
    expect(interpret('LOAD "PLOT.BAS"')).toEqual({ kind: "load", name: "PLOT.BAS" });
    expect(interpret("load snake.asm")).toEqual({ kind: "load", name: "SNAKE.ASM" });
    expect(interpret("LOAD NOPE.BAS")).toEqual({
      kind: "print",
      text: "?FILE NOT FOUND: NOPE.BAS",
    });
  });

  it("switches phosphor only to one there is", () => {
    expect(interpret("phosphor amber")).toEqual({ kind: "phosphor", phosphor: "amber" });
    expect(interpret("PHOSPHOR PINK")).toEqual({ kind: "print", text: "?GREEN, AMBER OR WHITE" });
  });

  it("answers anything else with a syntax error, and nothing with nothing", () => {
    expect(interpret("run")).toEqual({ kind: "print", text: "?SYNTAX ERROR: RUN" });
    expect(interpret("   ")).toEqual({ kind: "print", text: "" });
    expect(interpret("cls")).toEqual({ kind: "clear" });
  });
});

describe("revealedCount", () => {
  it("counts every character but the line breaks", () => {
    expect(revealedCount("ab\ncd", 2)).toBe(2);
    expect(revealedCount("ab\ncd", 3)).toBe(2);
    expect(revealedCount("ab\ncd", 4)).toBe(3);
    expect(revealedCount("ab\n  cd", 7)).toBe(6);
  });

  it("stops at the end of the text", () => {
    expect(revealedCount("ab\ncd", 99)).toBe(4);
  });
});

describe("Terminal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("types a program out and then prompts", () => {
    const terminal = new Terminal();
    expect(terminal.load("PLOT.BAS")).toBe(true);
    const listing = terminal.listing.get();
    expect(listing).toBe(`LOAD "PLOT.BAS"\n${PROGRAMS["PLOT.BAS"]}`);
    // The LOAD line is there at once; the program comes off the disk.
    expect(terminal.typed.get()).toBe(`LOAD "PLOT.BAS"\n`.length);
    expect(terminal.typing.get()).toBe(true);
    expect(terminal.console.get()).toBe("");

    vi.advanceTimersByTime(60_000);
    expect(terminal.typed.get()).toBe(listing.length);
    expect(terminal.typing.get()).toBe(false);
    expect(terminal.console.get()).toBe("\n\nREADY.\n> ");
    terminal.dispose();
  });

  it("refuses a disk it does not have", () => {
    const terminal = new Terminal();
    expect(terminal.load("NOPE.BAS")).toBe(false);
    expect(terminal.typing.get()).toBe(false);
  });

  it("ignores keys while a program is typing", () => {
    const terminal = new Terminal();
    terminal.load("PLOT.BAS");
    terminal.key("a");
    vi.advanceTimersByTime(60_000);
    expect(terminal.console.get()).toBe("\n\nREADY.\n> ");
  });

  it("runs what is typed at the prompt", () => {
    const terminal = new Terminal();
    terminal.load("PLOT.BAS");
    vi.advanceTimersByTime(60_000);
    for (const key of "hellp") {
      terminal.key(key);
    }
    terminal.key("Backspace");
    terminal.key("o");
    expect(terminal.console.get()).toBe("\n\nREADY.\n> HELLO");
    terminal.key("Enter");
    expect(terminal.console.get()).toBe(
      "\n\nREADY.\n> HELLO\nHELLO FROM A <PRE> IN A WEBGL SCENE\n> ",
    );
  });

  it("changes phosphor from the prompt", () => {
    const terminal = new Terminal();
    for (const key of "phosphor white") {
      terminal.key(key);
    }
    terminal.key("Enter");
    expect(terminal.phosphor.get()).toBe("white");
    expect(terminal.console.get()).toBe("> PHOSPHOR WHITE\nOK - WHITE\n> ");
  });

  it("loads another disk from the prompt", () => {
    const terminal = new Terminal();
    for (const key of "load snake.asm") {
      terminal.key(key);
    }
    terminal.key("Enter");
    expect(terminal.listing.get().startsWith(`LOAD "SNAKE.ASM"\n`)).toBe(true);
    expect(terminal.typing.get()).toBe(true);
    terminal.dispose();
    expect(terminal.typing.get()).toBe(false);
  });

  it("clears the screen", () => {
    const terminal = new Terminal();
    terminal.load("PLOT.BAS");
    vi.advanceTimersByTime(60_000);
    for (const key of "cls") {
      terminal.key(key);
    }
    terminal.key("Enter");
    expect(terminal.listing.get()).toBe("");
    expect(terminal.console.get()).toBe("> ");
  });
});
