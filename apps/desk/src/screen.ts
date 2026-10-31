import { children, text } from "@apendua/justdom";
import { component, effect, just, observable } from "@apendua/signal";
import type { Readable } from "./session.js";
import { makeReveal, scrollElementBy } from "@apendua/freedom";
import { revealedCount, type Terminal } from "./terminal.js";

/**
 * Draw the terminal on the monitor's screen.
 *
 * On the page the listing is the typed part of it, rewritten a tick at a
 * time. In a session the text node holds the whole listing from the start
 * and `makeReveal` draws as much of it as is typed, so a tick is a uniform
 * write rather than a re-measured, re-rasterized run. The terminal's state
 * is the same for both; only the node the listing is in changes, when a
 * session starts or ends.
 */
export function mountScreen(
  screen: HTMLElement,
  terminal: Terminal,
  presenting: Readable<boolean>,
) {
  const program = screen.querySelector<HTMLElement>("[data-program]");
  const prompt = screen.querySelector<HTMLElement>("[data-prompt]");
  if (!program || !prompt) {
    throw new Error("The screen has no [data-program] or [data-prompt]");
  }

  const listing = observable(() => terminal.listing.get());
  const typedPart = observable(() => terminal.listing.get().slice(0, terminal.typed.get()));
  const reveal = makeReveal(() => revealedCount(terminal.listing.get(), terminal.typed.get()));

  const subscriptions = [
    just(program, [
      children(
        component(() => (presenting.get() ? reveal.text`${listing}` : text`${typedPart}`))(),
      ),
    ]).subscribe({ error: (err) => console.error("Could not draw the listing:", err) }),
    just(prompt, [children(text`${observable(() => terminal.console.get())}`)]).subscribe({
      error: (err) => console.error("Could not draw the prompt:", err),
    }),
  ];

  const attributes = effect(() => {
    screen.setAttribute("data-phosphor", terminal.phosphor.get());
    screen.toggleAttribute("data-typing", terminal.typing.get());
  });

  // Keep the line being typed in view. Read after the text above has been
  // written, which is a microtask later than the signals it follows.
  const scrolling = effect(() => {
    terminal.console.get();
    const typed = terminal.typed.get();
    // The characters typed while a session reveals the listing, and nothing
    // otherwise, when the bottom is the place to be.
    const revealed = presenting.get() && terminal.typing.get() ? typed : 0;
    queueMicrotask(() => {
      scrollElementBy(screen, 0, scrollTarget(screen, program, revealed) - screen.scrollTop);
    });
  });

  return () => {
    subscriptions.forEach((subscription) => subscription.unsubscribe());
    attributes.dispose();
    scrolling.dispose();
  };
}

/**
 * Where the screen is scrolled to. Everything in it is what has been typed,
 * so that is the bottom, except while a session reveals a listing: the node
 * holds all of it then, and the place to be is where the `revealed`th
 * character of it is.
 */
function scrollTarget(screen: HTMLElement, program: HTMLElement, revealed: number): number {
  const bottom = screen.scrollHeight - screen.clientHeight;
  const node = revealed ? firstText(program) : null;
  const typed = node ? Math.min(node.data.length, revealed) : 0;
  if (!node || typed === 0) {
    return bottom;
  }
  const range = document.createRange();
  range.setStart(node, typed - 1);
  range.setEnd(node, typed);
  const caret = range.getBoundingClientRect().bottom;
  const style = getComputedStyle(screen);
  const visibleBottom =
    screen.getBoundingClientRect().top + screen.clientHeight - parseFloat(style.paddingBottom);
  return Math.min(bottom, Math.max(0, screen.scrollTop + caret - visibleBottom));
}

function firstText(element: HTMLElement): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}
