import { Signal } from "justdom-signal";
import { mountDesk, type MountedDesk } from "./desk.js";
import { lookFromSearch, type Look } from "./looks.js";
import { mountLookPicker } from "./lookPicker.js";
import { presenting } from "./session.js";
import { mountStage } from "./stage.js";
import { canDrawHtmlInCanvas, panelsFromSearch } from "./texture/panels.js";
import { offerXR } from "./xr.js";
import "./index.css";

function find<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`The page has no ${selector}`);
  }
  return element;
}

// The texture variant types the monitor's listing into the page in a
// session as on the page, since the page is what its panels show; the
// mirror reveals a listing it holds whole.
const panels = panelsFromSearch(location.search);
document.documentElement.dataset.panels = panels;
const reveal = panels === "texture" ? { get: () => false } : presenting;

const desk = find("[data-desk]");
const stage = mountStage(find(".stage"), desk, presenting);
const fonts = find<HTMLLinkElement>("[data-look-fonts]");
const style = document.createElement("style");
document.head.appendChild(style);

/** Put `look` up, in place of whichever was up. */
function show(look: Look): MountedDesk {
  fonts.href = look.fonts;
  return mountDesk(desk, style, look, stage.scale, reveal);
}

// The desk on the page is whichever look the address names. The scene reads
// this as a session starts, so a session mirrors the look the page is
// showing.
const current = Signal.of(show(lookFromSearch(location.search)));

// The picker swaps one look for another in place, and writes the choice into
// the address so that a reload or a shared link opens the same desk. Not
// during a session, which mirrors the elements of the look it started with.
mountLookPicker(find<HTMLSelectElement>("[data-look-picker]"), current.get().look, (look) => {
  if (presenting.get()) {
    return;
  }
  current.get().dispose();
  current.set(show(look));
  const url = new URL(location.href);
  url.searchParams.set("look", look.id);
  history.replaceState(null, "", url);
});

find("[data-notes-toggle]").addEventListener("click", () => {
  document.body.classList.toggle("tags");
});

// And the headset, offered to a page that can open one: the scene mirrors
// the very elements the page is showing.
if (panels === "texture" && !canDrawHtmlInCanvas()) {
  find("[data-panels-notice]").hidden = false;
}
offerXR(current, panels).catch((err) => {
  console.error("Could not offer an XR session:", err);
});
