import { distinctUntilChanged, switchMap, type Observable } from "rxjs";
import { $, attr, children, list, on, renderText, set, text } from "@apendua/justdom";
import { effects, observable, onCleanup, Signal } from "@apendua/signal";
import { getPortalRoot } from "@apendua/freedom";
import type { Mountable } from "@apendua/justdom";
import {
  dropdownCaret,
  dropdownMenu,
  dropdownMenuUp,
  dropdownOption,
  dropdownOptionSelected,
  dropdownRoot,
  dropdownTrigger,
} from "../elements/styles.js";

export interface DropdownOption<T> {
  value: T;
  label: string;
}

export interface DropdownProps<T> {
  options: readonly DropdownOption<T>[];
  /** The chosen value, read reactively. */
  selected: () => T;
  onSelect: (value: T) => void;
  /** Shown on the trigger when nothing in `options` is selected. */
  placeholder?: string;
  /** Which way the menu opens. Up keeps it inside a panel it sits at the foot of. */
  direction?: "down" | "up";
}

/** The list is mounted or not; the item it holds is only there to be counted. */
const MENU = "menu";

/**
 * A dropdown made of ordinary elements, so that it works in a `freedom` portal
 * as well as on a page.
 *
 * A native `<select>` cannot: `<option>` has no CSS box to mirror, and the
 * list the browser pops up is chrome rather than DOM, so nothing of it reaches
 * the scene. Everything below is boxes and clicks, which the portal already
 * knows how to project.
 *
 * The menu is mounted and unmounted rather than hidden and shown. That is the
 * one thing worth remembering when writing for a portal: sizes are re-measured
 * when the tree changes, not when an attribute does, because otherwise every
 * hover would re-measure the panel. A menu that toggled `display` would
 * restyle and never re-lay-out.
 */
export function dropdown<T>(props: DropdownProps<T>): Observable<Mountable<Node>> {
  const { options, selected, onSelect, placeholder = "Choose…", direction = "down" } = props;

  const open = Signal.of(false);

  const isSelected = (option: DropdownOption<T>) => selected() === option.value;

  const label = () => options.find(isSelected)?.label ?? placeholder;

  const menuClass =
    direction === "up" ? renderText`${dropdownMenu} ${dropdownMenuUp}` : dropdownMenu;

  /**
   * The base class alone, or the base plus a modifier, following a signal —
   * the same trick the panels use to keep a state change down to one class
   * attribute rather than a rebuilt subtree.
   */
  const withModifier = (
    base: Observable<string>,
    modifier: Observable<string>,
    active: () => boolean,
  ): Observable<string> =>
    observable(active).pipe(
      distinctUntilChanged(),
      switchMap((on) => (on ? renderText`${base} ${modifier}` : base)),
    );

  const option = (entry: DropdownOption<T>) =>
    $("div", [
      set(
        "className",
        withModifier(dropdownOption, dropdownOptionSelected, () => isSelected(entry)),
      ),
      attr("role", () => "option"),
      attr("aria-selected", () => (isSelected(entry) ? "true" : "false")),
      on("click", () => {
        onSelect(entry.value);
        open.set(false);
      }),
      children(text`${() => entry.label}`),
    ]);

  const menu = () =>
    $("div", [
      set("className", menuClass),
      attr("role", () => "listbox"),
      children(list(() => options, option)),
    ]);

  return $("div", [
    set("className", dropdownRoot),
    // Anywhere else in the panel closes the menu. In a portal the panel's own
    // background reports its clicks to the DOM as well, so pointing at the
    // panel beside the menu and pulling the trigger counts as "elsewhere" the
    // same way pointing at another button does.
    //
    // Scoped to the panel rather than the document, and that is not a detail:
    // on the page around it there is a VR button, and in development an
    // emulator whose every control is a real mouse click. Listening to the
    // document would hear those too, and close the menu from under the very
    // trigger press that was meant to choose from it.
    effects((root: HTMLDivElement) => {
      if (!open.get()) {
        return;
      }
      const scope: HTMLElement | Document = getPortalRoot(root) ?? document;
      const onClickElsewhere = (event: Event) => {
        // The click that opened the menu is still on its way up, and it came
        // from inside.
        if (event.target instanceof Node && root.contains(event.target)) {
          return;
        }
        open.set(false);
      };
      scope.addEventListener("click", onClickElsewhere);
      onCleanup(() => {
        scope.removeEventListener("click", onClickElsewhere);
      });
    }),
    children(
      $("div", [
        set("className", dropdownTrigger),
        attr("role", () => "combobox"),
        attr("aria-expanded", () => (open.get() ? "true" : "false")),
        on("click", () => {
          open.set(!open.get());
        }),
        children(
          $("div", [children(text`${label}`)]),
          $("div", [
            set("className", dropdownCaret),
            children(text`${() => (open.get() ? "▲" : "▼")}`),
          ]),
        ),
      ]),
      list(() => (open.get() ? [MENU] : []), menu),
    ),
  ]);
}

export default dropdown;
