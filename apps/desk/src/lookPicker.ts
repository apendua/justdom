import { LOOKS, type Look } from "./looks.js";

/**
 * The menu in the corner that swaps the desk's look: an option for every
 * look, the one that is up chosen, and `onPick` told of each choice.
 *
 * Once a look is picked the menu lets go of focus. A select that keeps it
 * takes the keys typed for the monitor as type-ahead, so the P of
 * `LOAD PLOT.BAS` would pick Paper Studio and swap the desk mid-command.
 */
export function mountLookPicker(
  select: HTMLSelectElement,
  current: Look,
  onPick: (look: Look) => void,
) {
  for (const look of LOOKS) {
    select.add(new Option(look.name, look.id, false, look === current));
  }
  const onChange = () => {
    const look = LOOKS.find(({ id }) => id === select.value);
    select.blur();
    if (look) {
      onPick(look);
    }
  };
  select.addEventListener("change", onChange);
  return () => select.removeEventListener("change", onChange);
}
