import { Signal } from "@apendua/signal";
import { PROGRAMS } from "./programs.js";

export const PHOSPHORS = ["green", "amber", "white"] as const;
export type Phosphor = (typeof PHOSPHORS)[number];

export function isPhosphor(value: string): value is Phosphor {
  return (PHOSPHORS as readonly string[]).includes(value);
}

/** What a command line asks the terminal to do. */
export type Reply =
  | { kind: "print"; text: string }
  | { kind: "load"; name: string }
  | { kind: "clear" }
  | { kind: "phosphor"; phosphor: Phosphor };

/**
 * Read one command line. Verbs are case-blind and arguments may be quoted,
 * as `LOAD "PLOT.BAS"` is in the listing every program starts with.
 */
export function interpret(line: string): Reply {
  const [verb = "", ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ").replace(/"/g, "").toUpperCase();
  switch (verb.toUpperCase()) {
    case "":
      return { kind: "print", text: "" };
    case "HELP":
      return { kind: "print", text: "DIR  LOAD <NAME>  CLS  PHOSPHOR <GREEN|AMBER|WHITE>  HELLO" };
    case "DIR":
      return { kind: "print", text: Object.keys(PROGRAMS).join("\n") };
    case "CLS":
      return { kind: "clear" };
    case "LOAD":
      return arg in PROGRAMS
        ? { kind: "load", name: arg }
        : { kind: "print", text: `?FILE NOT FOUND: ${arg}` };
    case "PHOSPHOR": {
      const phosphor = arg.toLowerCase();
      return isPhosphor(phosphor)
        ? { kind: "phosphor", phosphor }
        : { kind: "print", text: "?GREEN, AMBER OR WHITE" };
    }
    case "HELLO":
      return { kind: "print", text: "HELLO FROM A <PRE> IN A WEBGL SCENE" };
    default:
      return { kind: "print", text: `?SYNTAX ERROR: ${verb.toUpperCase()}` };
  }
}

/**
 * How many characters a revealed run has drawn once `typed` characters of
 * `text` are typed. The reveal counts the characters glyphs were drawn for,
 * and in a `<pre>` that is every character but the line breaks, which end a
 * line rather than standing on one.
 */
export function revealedCount(text: string, typed: number): number {
  let breaks = 0;
  const end = Math.min(typed, text.length);
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 10) {
      breaks++;
    }
  }
  return end - breaks;
}

/** Characters typed per tick, and the tick, while a program loads. */
const CHARS_PER_TICK = 2;
const TICK_MS = 28;

/**
 * The state of the monitor: the program being typed out and how much of it
 * is, the command lines after it, and the phosphor. Nothing here touches
 * the DOM; `screen.ts` draws it, and draws it differently on the page and in
 * a session.
 */
export class Terminal {
  /** The listing being typed: the `LOAD` line and the program after it. */
  readonly listing = Signal.of("");
  /** How many characters of `listing` are typed. */
  readonly typed = Signal.of(0);
  /** What follows the listing: the prompt, the commands and their replies. */
  readonly console = Signal.of("");
  readonly phosphor = Signal.of<Phosphor>("green");
  /** Whether a program is still being typed out, when keys do nothing. */
  readonly typing = Signal.of(false);

  private history = "";
  private line = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  load(name: string): boolean {
    const program = PROGRAMS[name];
    if (program === undefined) {
      return false;
    }
    this.stop();
    const listing = `LOAD "${name}"\n${program}`;
    this.history = "";
    this.line = "";
    this.console.set("");
    this.listing.set(listing);
    // The LOAD line is there at once, as though it had been typed at the
    // prompt; the program is what comes off the disk.
    const header = listing.length - program.length;
    this.typed.set(header);
    this.typing.set(true);
    this.timer = setInterval(() => {
      const typed = Math.min(listing.length, this.typed.get() + CHARS_PER_TICK);
      this.typed.set(typed);
      if (typed >= listing.length) {
        this.stop();
        this.history = "\n\nREADY.\n";
        this.showPrompt();
      }
    }, TICK_MS);
    return true;
  }

  /** A key, named as `KeyboardEvent.key` names it. */
  key(key: string): void {
    if (this.typing.get()) {
      return;
    }
    if (key === "Enter") {
      this.enter();
      return;
    }
    if (key === "Backspace") {
      this.line = this.line.slice(0, -1);
    } else if (key.length === 1) {
      this.line += key.toUpperCase();
    } else {
      return;
    }
    this.showPrompt();
  }

  dispose(): void {
    this.stop();
  }

  private enter(): void {
    const reply = interpret(this.line);
    const echo = `> ${this.line}\n`;
    this.line = "";
    switch (reply.kind) {
      case "load":
        this.load(reply.name);
        return;
      case "clear":
        this.listing.set("");
        this.typed.set(0);
        this.history = "";
        break;
      case "phosphor":
        this.phosphor.set(reply.phosphor);
        this.history += `${echo}OK - ${reply.phosphor.toUpperCase()}\n`;
        break;
      case "print":
        this.history += echo + (reply.text ? `${reply.text}\n` : "");
        break;
    }
    this.showPrompt();
  }

  private showPrompt(): void {
    this.console.set(`${this.history}> ${this.line}`);
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.typing.set(false);
  }
}
