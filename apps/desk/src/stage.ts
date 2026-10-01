import { effect } from "@apendua/signal";
import type { Signal } from "@apendua/signal";

/** The size the desk is drawn at, in px. */
export const DESK_WIDTH = 1600;
export const DESK_HEIGHT = 1000;

/**
 * Scale the desk to fit the window, and take the scaling and the tilts off
 * while a session mirrors it (`html[data-presenting]` in the stylesheet), so
 * that every object is measured flat and at its own size.
 *
 * Returns how many screen px a desk px is right now, which is one while a
 * session runs.
 */
export function mountStage(stage: HTMLElement, desk: HTMLElement, presenting: Signal<boolean>) {
  let scale = 1;
  const fit = () => {
    scale = presenting.get()
      ? 1
      : Math.min(stage.clientWidth / DESK_WIDTH, stage.clientHeight / DESK_HEIGHT) || 1;
    desk.style.transform = `scale(${scale})`;
  };
  const staging = effect(() => {
    document.documentElement.toggleAttribute("data-presenting", presenting.get());
    fit();
  });
  window.addEventListener("resize", fit);
  return {
    scale: () => scale,
    dispose: () => {
      staging.dispose();
      window.removeEventListener("resize", fit);
    },
  };
}
