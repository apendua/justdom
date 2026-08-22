import { distinctUntilChanged, switchMap } from "rxjs";
import { $, attr, children, list, on, renderText, set, text } from "@apendua/justdom";
import { effects, observable, onCleanup, Signal } from "@apendua/signal";
import { getPortalRoot } from "@apendua/freedom";

/**
 * @import {Observable} from "rxjs";
 * @import {Mountable} from "@apendua/justdom";
 */

/**
 * @template T
 * @typedef {object} DropdownOption
 * @property {T} value
 * @property {string} label
 */

/**
 * What the widget is dressed in — `stylesheet` class names, one per part,
 * because the structure is the only part worth sharing between scenes: a
 * panel's dropdown has to look like that panel, and a library that shipped its
 * own colours would be fought rather than used.
 *
 * Which way the menu opens is a class too, not an option here: `top: 100%` or
 * `bottom: 100%` says it in one line, and only the panel knows which of the two
 * keeps the menu over itself rather than hanging into the room.
 *
 * @typedef {object} DropdownClasses
 * @property {Observable<string>} root The positioning context the menu is
 *   placed against: `position: relative`.
 * @property {Observable<string>} trigger The closed control, naming whatever is
 *   currently chosen. Needs `cursor: pointer` to be a ray target.
 * @property {Observable<string>} [caret] The open/closed mark. Omit to leave
 *   the trigger with nothing but its label.
 * @property {Observable<string>} menu The list. Must be positioned and stacked
 *   above (`position: absolute; z-index: 1`) — see the layers section of the
 *   README for what that buys in a scene — and out of the flow, or opening it
 *   resizes the panel it hangs off.
 * @property {Observable<string>} option One row.
 * @property {Observable<string>} [optionSelected] Added to the row that is
 *   currently chosen.
 */

/**
 * @template T
 * @typedef {object} DropdownProps
 * @property {readonly DropdownOption<T>[] | (() => readonly DropdownOption<T>[])} options
 *   What can be chosen. A function is read reactively, for a list that changes
 *   under the player — devices coming and going, a document being edited.
 * @property {() => T} selected The chosen value, read reactively.
 * @property {(value: T) => void} onSelect
 * @property {DropdownClasses} classes
 * @property {string} [placeholder] Shown on the trigger when nothing in
 *   `options` is selected.
 * @property {readonly [open: string, closed: string]} [caretMarks] What the
 *   caret says when the menu is open and when it is shut.
 */

/** The list is mounted or not; the item it holds is only there to be counted. */
const MENU = "menu";

const DEFAULT_CARET_MARKS = /** @type {const} */ (["▲", "▼"]);

/**
 * A dropdown made of ordinary elements, so that it works in a `dom(ctx, ...)`
 * portal as well as on a page.
 *
 * A native `<select>` cannot: `<option>` has no CSS box to mirror, and the list
 * the browser pops up is chrome rather than DOM, so nothing of it reaches the
 * scene. Everything below is boxes and clicks, which the portal already knows
 * how to project.
 *
 * The menu is mounted and unmounted rather than hidden and shown. That is the
 * one thing worth remembering when writing for a portal: sizes are re-measured
 * when the tree changes, not when an attribute does, because otherwise every
 * hover would re-measure the panel. A menu that toggled `display` would
 * restyle and never re-lay-out.
 *
 * @template T
 * @param {DropdownProps<T>} props
 * @returns {Observable<Mountable>}
 */
export function dropdown(props) {
  const {
    options,
    selected,
    onSelect,
    classes,
    placeholder = "Choose…",
    caretMarks = DEFAULT_CARET_MARKS,
  } = props;

  const open = Signal.of(false);
  const getOptions = typeof options === "function" ? options : () => options;

  /** @param {DropdownOption<T>} option */
  const isSelected = (option) => selected() === option.value;

  const label = () => getOptions().find(isSelected)?.label ?? placeholder;

  /**
   * The base class alone, or the base plus a modifier, following a signal —
   * the same trick the panels use to keep a state change down to one class
   * attribute rather than a rebuilt subtree.
   *
   * @param {Observable<string>} base
   * @param {Observable<string>} modifier
   * @param {() => boolean} active
   * @returns {Observable<string>}
   */
  const withModifier = (base, modifier, active) =>
    observable(active).pipe(
      distinctUntilChanged(),
      switchMap((isActive) => (isActive ? renderText`${base} ${modifier}` : base)),
    );

  /** @param {DropdownOption<T>} entry */
  const option = (entry) =>
    $("div", [
      set(
        "className",
        classes.optionSelected
          ? withModifier(classes.option, classes.optionSelected, () => isSelected(entry))
          : classes.option,
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
      set("className", classes.menu),
      attr("role", () => "listbox"),
      children(list(getOptions, option)),
    ]);

  return $("div", [
    set("className", classes.root),
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
    effects((/** @type {HTMLDivElement} */ root) => {
      if (!open.get()) {
        return;
      }
      /** @type {HTMLElement | Document} */
      const scope = getPortalRoot(root) ?? document;
      /** @param {Event} event */
      const onClickElsewhere = (event) => {
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
        set("className", classes.trigger),
        attr("role", () => "combobox"),
        attr("aria-expanded", () => (open.get() ? "true" : "false")),
        on("click", () => {
          open.set(!open.get());
        }),
        children(
          $("div", [children(text`${label}`)]),
          ...(classes.caret
            ? [
                $("div", [
                  set("className", classes.caret),
                  children(text`${() => (open.get() ? caretMarks[0] : caretMarks[1])}`),
                ]),
              ]
            : []),
        ),
      ]),
      list(() => (open.get() ? [MENU] : []), menu),
    ),
  ]);
}

export default dropdown;
