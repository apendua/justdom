import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Signal } from "@apendua/signal";
import { mountScreen } from "./screen.js";
import { Terminal } from "./terminal.js";

function screen() {
  document.body.innerHTML = `
    <div data-screen><pre class="crt"><span data-program></span><span data-prompt></span><span class="cursor"></span></pre></div>`;
  const element = document.querySelector<HTMLElement>("[data-screen]")!;
  return {
    element,
    program: element.querySelector<HTMLElement>("[data-program]")!,
    prompt: element.querySelector<HTMLElement>("[data-prompt]")!,
  };
}

/** Let the signals settle and the text they drive be written. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("mountScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom lays nothing out and has no rects for a range; the screen asks
    // for one to scroll a revealed listing, and a blank one will do here.
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the typed part of the listing on the page", async () => {
    const { element, program, prompt } = screen();
    const terminal = new Terminal();
    const dispose = mountScreen(element, terminal, Signal.of(false));
    terminal.load("PLOT.BAS");
    await settle();
    expect(program.textContent).toBe(`LOAD "PLOT.BAS"\n`);
    expect(element.hasAttribute("data-typing")).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(program.textContent).toBe(terminal.listing.get());
    expect(prompt.textContent).toBe("\n\nREADY.\n> ");
    expect(element.hasAttribute("data-typing")).toBe(false);
    dispose();
    terminal.dispose();
  });

  it("holds the whole listing in a revealed node while a session presents", async () => {
    const { element, program } = screen();
    const terminal = new Terminal();
    const presenting = Signal.of(false);
    const dispose = mountScreen(element, terminal, presenting);
    terminal.load("PLOT.BAS");
    await settle();

    presenting.set(true);
    await settle();
    // Only the LOAD line is typed, but the node has all of it: the scene
    // draws the typed part.
    expect(terminal.typed.get()).toBeLessThan(terminal.listing.get().length);
    expect(program.textContent).toBe(terminal.listing.get());

    presenting.set(false);
    await settle();
    expect(program.textContent).toBe(`LOAD "PLOT.BAS"\n`);
    dispose();
    terminal.dispose();
  });

  it("says which phosphor the screen is", async () => {
    const { element } = screen();
    const terminal = new Terminal();
    const dispose = mountScreen(element, terminal, Signal.of(false));
    terminal.phosphor.set("amber");
    await settle();
    expect(element.getAttribute("data-phosphor")).toBe("amber");
    dispose();
  });
});
