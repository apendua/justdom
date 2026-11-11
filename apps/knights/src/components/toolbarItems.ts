import { attr, children, on, set, text, $ } from "justdom-core";
import { canPassThrough, passthrough, xrSession } from "justdom-xr/session";
import { VERSUS_COMPUTER, type GameMode } from "../store/Root";
import { menuItem } from "./styles";

/**
 * The passthrough switch, pressable only in a session that can show the
 * room, and white while the room shows.
 */
export const PassthroughItem = () =>
  $("li", [
    set("className", menuItem),
    attr("data-disabled", () => (canPassThrough() ? undefined : "")),
    attr("data-inverted", () => (passthrough.get() && canPassThrough() ? "" : undefined)),
    on("click", () => {
      if (canPassThrough()) {
        passthrough.set(!passthrough.get());
      }
    }),
    children(text`Passthrough`),
  ]);

/** Whether a headset session is running. */
export const inSession = () => xrSession.get() !== null;

/**
 * The item that ends the session: the × at the end of the toolbar, with a
 * title to say what it does, or a line in the menu that says it itself and
 * closes the menu with `onLeave`, so the player is back on the board.
 */
export const LeaveItem = (caption: "×" | "Leave the headset", onLeave?: () => void) =>
  $("li", [
    set("className", menuItem),
    attr({ title: caption === "×" ? "Leave the headset" : undefined }),
    on("click", () => {
      void xrSession.get()?.end();
      onLeave?.();
    }),
    children(text`${caption}`),
  ]);

/** How the battle is being played, as the toolbar and the menu name it. */
export const modeName = (mode: GameMode) => (mode === VERSUS_COMPUTER ? "vs Computer" : "Hotseat");
