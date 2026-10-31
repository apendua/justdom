import { LOOKS, type Look } from "./looks.js";

/**
 * The menu in the corner that swaps the desk's look: an option for every
 * look, the one that is up chosen, and `onPick` told of each choice.
 *
 * The menu keeps focus after a choice, as a select does. The characters
 * typed next are the monitor's all the same: `mountKeyboard` keeps a
 * focused control from acting on them, so the P of `LOAD PLOT.BAS` does not
 * pick Paper Studio.
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
    if (look) {
      onPick(look);
    }
  };
  select.addEventListener("change", onChange);
  return () => select.removeEventListener("change", onChange);
}
