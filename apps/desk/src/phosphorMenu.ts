import { effect } from "@apendua/signal";
import { getPortalRoot } from "@apendua/freedom";
import { isPhosphor, type Terminal } from "./terminal.js";

/**
 * The PHOSPHOR control under the screen: a button that opens a menu of the
 * three phosphors.
 *
 * The menu is mounted when it opens and taken out when it closes. It is
 * positioned and stacked (`.menu` in the stylesheet), which makes it a
 * layer of its own in a session, floating clear of the monitor and opaque
 * to the ray.
 */
export function mountPhosphorMenu(
  knob: HTMLElement,
  template: HTMLTemplateElement,
  terminal: Terminal,
) {
  let menu: HTMLElement | null = null;
  const close = () => {
    menu?.remove();
    menu = null;
  };

  const onKnob = (event: MouseEvent) => {
    event.stopPropagation();
    if (menu) {
      close();
      return;
    }
    const opened = template.content.firstElementChild?.cloneNode(true);
    if (!(opened instanceof HTMLElement)) {
      return;
    }
    opened.addEventListener("click", (pick) => {
      const phosphor = (pick.target as Element).closest<HTMLElement>("[data-pick]")?.dataset.pick;
      if (phosphor && isPhosphor(phosphor)) {
        terminal.phosphor.set(phosphor);
      }
      close();
    });
    knob.parentElement?.append(opened);
    menu = opened;
  };

  // A click anywhere else closes it. In a session the ones that count are
  // the monitor panel's own: a click on the page around the scene, such as
  // the emulator's controls, is not a click elsewhere on the desk.
  const onDocument = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!menu || menu.contains(target)) {
      return;
    }
    const panel = getPortalRoot(knob);
    if (panel && !panel.contains(target)) {
      return;
    }
    close();
  };

  const labels = knob.querySelectorAll<HTMLElement>("[data-phosphor-label]");
  const label = effect(() => {
    const phosphor = terminal.phosphor.get().toUpperCase();
    labels.forEach((element) => (element.textContent = phosphor));
  });

  knob.addEventListener("click", onKnob);
  document.addEventListener("click", onDocument);
  return () => {
    close();
    label.dispose();
    knob.removeEventListener("click", onKnob);
    document.removeEventListener("click", onDocument);
  };
}
