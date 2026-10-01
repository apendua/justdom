import { mountCharts } from "./charts.js";
import { mountClock } from "./clock.js";
import { mountDragAndDrop, mountNewNotes } from "./dragAndDrop.js";
import { mountKeyboard } from "./keyboard.js";
import { mountPhosphorMenu } from "./phosphorMenu.js";
import { BOOT_PROGRAM } from "./programs.js";
import { mountScreen } from "./screen.js";
import { mountPowerButton } from "./power.js";
import { presenting, xrSession } from "./session.js";
import { mountStage } from "./stage.js";
import { Terminal } from "./terminal.js";
import { offerXR } from "./xr.js";
import { PLACEMENTS } from "./components/Scene.js";
import "./index.css";

function find<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`The page has no ${selector}`);
  }
  return element;
}

// The desk is the page's markup, index.html. What follows makes it move.
const stage = mountStage(find(".stage"), find(".desk"), presenting);
const terminal = new Terminal();

mountScreen(find("[data-screen]"), terminal, presenting);
mountPhosphorMenu(
  find("[data-phosphor-knob]"),
  find<HTMLTemplateElement>("#phosphor-menu"),
  terminal,
);
mountPowerButton(find("[data-power]"), xrSession);
mountKeyboard(find("[data-keys]"), { onKey: (key) => terminal.key(key) });
mountDragAndDrop({
  board: find("[data-board]"),
  drive: find("[data-drive]"),
  load: (name) => terminal.load(name),
  scale: stage.scale,
});
mountNewNotes(
  find("[data-board]"),
  find<HTMLInputElement>("[data-new-note]"),
  find<HTMLTemplateElement>("#note-template"),
);
mountCharts(find("#charts"));
mountClock(find("#clock"));

find("[data-notes-toggle]").addEventListener("click", () => {
  document.body.classList.toggle("tags");
});

// A moment's pause before the disk spins up, as there was on the real thing.
setTimeout(() => terminal.load(BOOT_PROGRAM), 400);

// And the headset, offered to a page that can open one: the scene mirrors
// the very elements the page is showing.
offerXR(new Map(PLACEMENTS.map(({ id }) => [id, find(`#${id}`)]))).catch((err) => {
  console.error("Could not offer an XR session:", err);
});
