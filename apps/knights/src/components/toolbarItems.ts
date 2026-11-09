import { attr, children, list, on, set, text, $, type Mountable } from "justdom-core";
import type { Subscribable } from "justdom-signal";
import { canPassThrough, passthrough, xrSession } from "justdom-xr/session";
import { VERSUS_COMPUTER, type GameMode } from "../store/Root";
import { menuItem } from "./styles";

/**
 * Mount what `render` makes while `when` holds, and take it down when it
 * stops. Not hidden and shown: a panel measures the toolbar again when its
 * children change, and not when one of them is hidden.
 */
export const mountedWhile = (when: () => boolean, render: () => Subscribable<Mountable>) =>
  list(() => (when() ? [true] : []), render);

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

/** The item that ends the session, read as `caption`. */
export const LeaveItem = (caption: string) =>
  $("li", [
    set("className", menuItem),
    attr({ title: "Leave the headset" }),
    on("click", () => {
      void xrSession.get()?.end();
    }),
    children(text`${caption}`),
  ]);

/** How the battle is being played, as the toolbar and the menu name it. */
export const modeName = (mode: GameMode) => (mode === VERSUS_COMPUTER ? "vs Computer" : "Hotseat");
