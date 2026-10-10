import { effect } from "@apendua/signal";
import { mountCharts } from "./charts.js";
import { mountClock, mountDigitalClocks } from "./clock.js";
import { mountDragAndDrop, mountNewNotes } from "./dragAndDrop.js";
import { mountKeyboard } from "./keyboard.js";
import type { Look } from "./looks.js";
import { mountPhosphorMenu } from "./phosphorMenu.js";
import { mountPowerButton } from "./power.js";
import { mountScreen } from "./screen.js";
import { xrSession } from "@apendua.dev/headset/session";
import { presenting } from "./session.js";
import { mountSwatches } from "./swatches.js";
import { mountTabs } from "./tabs.js";
import { Terminal } from "./terminal.js";

/** A look put up on the page: the elements a session mirrors, and the way to take it down. */
export interface MountedDesk {
  look: Look;
  /** The zones named by the look's placements, by id. */
  elements: ReadonlyMap<string, HTMLElement>;
  dispose: () => void;
}

/**
 * Put `look` up on `desk` and make it move: its markup inside the desk, its
 * stylesheet in `style`, and every behaviour its markup asks for. Each look
 * has a monitor, a keyboard, a board and something to load the monitor
 * from; the rest (a clock with hands, digital clocks, a notebook's tabs,
 * colour swatches, a field for new notes) is mounted where the look has it.
 *
 * `dispose` takes it all down again, timers and listeners included, and
 * empties the desk for the next look.
 */
export function mountDesk(
  desk: HTMLElement,
  style: HTMLStyleElement,
  look: Look,
  scale: () => number,
): MountedDesk {
  desk.dataset.look = look.id;
  style.textContent = look.style;
  desk.innerHTML = look.markup;

  const find = <T extends Element = HTMLElement>(selector: string): T => {
    const element = desk.querySelector<T>(selector);
    if (!element) {
      throw new Error(`The ${look.name} desk has no ${selector}`);
    }
    return element;
  };
  const optional = <T extends Element = HTMLElement>(selector: string) =>
    desk.querySelector<T>(selector);

  const terminal = new Terminal();
  terminal.phosphor.set(look.phosphor);

  const disposers: (() => void)[] = [
    () => terminal.dispose(),
    mountScreen(find("[data-screen]"), terminal, presenting),
    mountPhosphorMenu(
      find("[data-phosphor-knob]"),
      find<HTMLTemplateElement>("#phosphor-menu"),
      terminal,
    ),
    mountPowerButton(find("[data-power]"), xrSession),
    mountKeyboard(find("[data-keys]"), { onKey: (key) => terminal.key(key) }),
    mountDragAndDrop({
      board: find("[data-board]"),
      drive: find("[data-drive]"),
      load: (name) => terminal.load(name),
      scale,
    }),
    mountDigitalClocks(desk),
    mountSwatches(desk),
  ];

  // The drive's light flashes while a program is coming off it.
  const led = optional("[data-led]");
  if (led) {
    const flashing = effect(() => led.toggleAttribute("data-busy", terminal.typing.get()));
    disposers.push(() => flashing.dispose());
  }

  const field = optional<HTMLInputElement>("[data-new-note]");
  if (field) {
    disposers.push(
      mountNewNotes(find("[data-board]"), field, find<HTMLTemplateElement>("#note-template")),
    );
  }

  // The tabs after the charts, so that every page they put up, the first
  // one included, is drawn as it goes up.
  const drawn = mountCharts(find("#charts"));
  const tabs = optional("[data-tabs]");
  disposers.push(drawn.dispose);
  if (tabs) {
    disposers.push(mountTabs(tabs, drawn.draw));
  }

  if (optional("[data-hand]")) {
    disposers.push(mountClock(desk));
  }

  // A moment's pause before the program loads, as there was on the real thing.
  const boot = setTimeout(() => terminal.load(look.boot), 400);
  disposers.push(() => clearTimeout(boot));

  return {
    look,
    elements: new Map(look.placements.map(({ id }) => [id, find(`#${id}`)])),
    dispose: () => {
      disposers.forEach((dispose) => dispose());
      desk.replaceChildren();
    },
  };
}
