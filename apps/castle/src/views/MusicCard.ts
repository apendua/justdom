import { component, on, set } from "justdom-signal";
import { children, $, text } from "justdom";
import { dropdown } from "justdom-three-ui";
import type { AudioOutputSelection } from "@apendua/sound";
import { musicRow, outputClasses, panelCard, panelTitle, stepButton, stepValue } from "./styles.js";

/** What the card shows. Both phases' panels carry these among their own props. */
export interface MusicCardState {
  /** How loud the soundtrack is, from 0 to 1. */
  volume: number;
}

export interface MusicCardActions {
  quieter: () => void;
  louder: () => void;
}

/**
 * The soundtrack's card. Building and besieging are two panels rather than two
 * halves of one, and the music plays through both, so the card is written once
 * here and dropped into either stack.
 *
 * `state` is meant to be a panel's own props store: reading from it here is what
 * ties the readings to it. `output` is the scene's own, which the picker both
 * shows and sets.
 */
export function musicCard(
  state: MusicCardState,
  actions: MusicCardActions,
  output: AudioOutputSelection,
) {
  return $("div", [
    set("className", panelCard),
    children(
      $("div", [set("className", panelTitle), children(text`Music`)]),
      $("div", [
        set("className", musicRow),
        children(
          $("div", [set("className", stepButton), on("click", actions.quieter), children(text`-`)]),
          $("div", [
            set("className", stepValue),
            children(text`${() => `${Math.round(state.volume * 100)}%`}`),
          ]),
          $("div", [set("className", stepButton), on("click", actions.louder), children(text`+`)]),
        ),
      ]),
      // Nothing to switch between is nothing to show: most headsets have one way
      // out for sound, and it is only a desktop with a headset plugged in next
      // to its speakers that has a choice worth making.
      component(() => {
        if (output.outputs.get().length < 2) {
          return text``;
        }
        return dropdown({
          options: () =>
            output.outputs.get().map(({ deviceId, label }) => ({ value: deviceId, label })),
          classes: outputClasses,
          placeholder: "Browser's choice",
          selected: () => output.deviceId.get(),
          onSelect: (deviceId) => output.select(deviceId),
        });
      })(),
    ),
  ]);
}
