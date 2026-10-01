import {
  $,
  attr,
  children,
  className,
  CLASS_NAME,
  list,
  on,
  set,
  style,
  stylesheet,
  text,
} from "@apendua/justdom";
import type { Mountable } from "@apendua/justdom";
import { component, type Subscribable } from "@apendua/signal";
import { Fields } from "../store/Fields";
import { canPassThrough, passthrough, xrSession } from "../session";

export interface SizePreset {
  id: string;
  label: string;
  nRows: number;
  nColumns: number;
  minesRatio: number;
}

interface MenuProps {
  presets: SizePreset[];
  selectedId: string;
  game: Fields;
  onSelect: (preset: SizePreset) => void;
  onRestart: () => void;
}

/*
 * Every hover and press rule is written twice, for `:hover` and `:active`
 * and for `[data-xr-hover]` and `[data-xr-active]`: the first pair is the
 * page's, the second is what a headset's ray sets on the element it is on.
 * A control is anything with `cursor: pointer`, which is also what makes it
 * pressable by the ray.
 */

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const INK = "#212529";
const DIM = "#868e96";
const EDGE = "#dee2e6";
const GREEN = "#2f9e44";
const RED = "#e03131";

const card = stylesheet`
  .${CLASS_NAME} {
    /* What the × in the corner is placed against. */
    position: relative;
    box-sizing: border-box;
    width: 248px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    background: #ffffff;
    border: 1px solid ${EDGE};
    border-radius: 14px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    font-family: ${FONT};
    color: ${INK};
  }

  /* On a phone the card is a bar across the top, where a board fitted to a
     narrow window leaves room. */
  @media (max-width: 600px) {
    .${CLASS_NAME} {
      width: auto;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      padding: 10px;
    }
  }
`;

const title = className`
  font-size: 16px;
  font-weight: 700;
  line-height: 36px;
`;

const sectionLabel = className`
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${DIM};
`;

const presetGroup = className`
  display: flex;
  gap: 4px;
  background: #e9ecef;
  border-radius: 8px;
  padding: 4px;
`;

const pressable = `
  cursor: pointer;
  user-select: none;
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    transform 0.15s ease;
`;

/** A size to choose, or a switch: dark text on nothing until it is on. */
const segment = stylesheet`
  .${CLASS_NAME} {
    flex: 1;
    border: none;
    background: transparent;
    padding: 6px 12px;
    border-radius: 6px;
    font-family: ${FONT};
    font-size: 13px;
    font-weight: 600;
    color: #495057;
    ${pressable}
  }

  .${CLASS_NAME}:hover,
  .${CLASS_NAME}[data-xr-hover] {
    background: #dee2e6;
  }

  .${CLASS_NAME}[data-on] {
    background: ${GREEN};
    color: #ffffff;
  }

  .${CLASS_NAME}:active,
  .${CLASS_NAME}[data-xr-active] {
    transform: scale(0.95);
  }

  .${CLASS_NAME}:disabled {
    cursor: default;
    color: #ced4da;
    background: transparent;
  }
`;

const stats = className`
  display: flex;
  gap: 8px;
`;

const counter = className`
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  padding: 6px 12px;
  border-radius: 6px;
  background: ${INK};
  color: #ff6b6b;
  font-family: 'Courier New', Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 16px;
`;

const statusBadge = className`
  flex: 1;
  padding: 7px 14px;
  border-radius: 8px;
  font-weight: 700;
  font-size: 13px;
  text-align: center;
  transition: background-color 0.15s ease, color 0.15s ease;
`;

const restartButton = stylesheet`
  .${CLASS_NAME} {
    border: none;
    background: #343a40;
    color: #ffffff;
    padding: 8px 14px;
    border-radius: 8px;
    font-family: ${FONT};
    font-size: 13px;
    font-weight: 600;
    ${pressable}
  }

  .${CLASS_NAME}:hover,
  .${CLASS_NAME}[data-xr-hover] {
    background: #495057;
  }

  .${CLASS_NAME}:active,
  .${CLASS_NAME}[data-xr-active] {
    transform: scale(0.97);
  }
`;

const hint = className`
  font-size: 11px;
  color: ${DIM};
`;

/** Ends the session; there only while there is one. */
const closeButton = stylesheet`
  .${CLASS_NAME} {
    position: absolute;
    top: 14px;
    right: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 1px solid ${EDGE};
    border-radius: 18px;
    background: #f1f3f5;
    color: #495057;
    font-family: ${FONT};
    font-size: 20px;
    line-height: 1;
    ${pressable}
  }

  .${CLASS_NAME}:hover,
  .${CLASS_NAME}[data-xr-hover] {
    background: ${RED};
    color: #ffffff;
  }

  .${CLASS_NAME}:active,
  .${CLASS_NAME}[data-xr-active] {
    transform: scale(0.92);
  }
`;

const heading = (caption: string) =>
  $("div", [set("className", sectionLabel), children(text`${caption}`)]);

/**
 * What only a session has, mounted while there is one and taken down when
 * it ends. Not hidden and shown: a panel measures the card again when its
 * children change, and not when one of them is hidden, so a section shown by
 * an attribute would hang out of the bottom of the card it grew.
 */
const inSession = (render: () => Subscribable<Mountable>) =>
  list(() => (xrSession.get() ? [true] : []), render);

/**
 * The menu: the board's size, the mines left, how the game stands, and a
 * restart. It is ordinary DOM on the page, floating over the board's corner,
 * and a headset session mirrors this very card into a panel of its own
 * beside the board.
 *
 * Two things are there only in a session, mounted when the scene says there
 * is one: the × in the card's top-right corner, which ends the session, and
 * a Headset section with the passthrough switch in it. The switch is there
 * in every session and pressable only in one that can show the room.
 */
const Menu = component((_ctx: WeakKey, props: MenuProps) => {
  return $("div", [
    attr("class", card),
    children(
      inSession(() =>
        $("button", [
          attr("class", closeButton),
          set({ type: "button", title: "Leave the headset" }),
          on("click", () => {
            void xrSession.get()?.end();
          }),
          children(text`\u00d7`),
        ]),
      ),
      $("div", [set("className", title), children(text`Hex Minesweeper`)]),
      heading("Board"),
      $("div", [
        set("className", presetGroup),
        children(
          ...props.presets.map((preset) =>
            $("button", [
              attr("class", segment),
              set({ type: "button" }),
              attr("data-on", () => (preset.id === props.selectedId ? "true" : undefined)),
              on("click", () => props.onSelect(preset)),
              children(text`${preset.label}`),
            ]),
          ),
        ),
      ]),
      $("div", [
        set("className", stats),
        children(
          $("div", [set("className", counter), children(text`${() => props.game.minesLeft}`)]),
          $("div", [
            set("className", statusBadge),
            style("background", () => {
              if (props.game.isWon) return GREEN;
              if (props.game.isLost) return RED;
              return "#f1f3f5";
            }),
            style("color", () => (props.game.isGameOver ? "#ffffff" : DIM)),
            children(
              text`${() => {
                if (props.game.isWon) return "You win!";
                if (props.game.isLost) return "Game over";
                return "Good luck!";
              }}`,
            ),
          ]),
        ),
      ]),
      $("button", [
        attr("class", restartButton),
        set({ type: "button" }),
        on("click", () => props.onRestart()),
        children(text`Restart`),
      ]),
      $("span", [
        set("className", hint),
        children(
          text`${() =>
            xrSession.get()
              ? "Squeeze the grip on a tile to flag it"
              : "Long-press or right-click a tile to flag it"}`,
        ),
      ]),
      inSession(() =>
        $("div", [
          children(
            heading("Headset"),
            $("div", [
              set("className", presetGroup),
              children(
                $("button", [
                  attr("class", segment),
                  set({ type: "button" }),
                  set("disabled", () => !canPassThrough()),
                  attr("data-on", () =>
                    passthrough.get() && canPassThrough() ? "true" : undefined,
                  ),
                  on("click", () => passthrough.set(!passthrough.get())),
                  children(text`Passthrough`),
                ]),
              ),
            ]),
          ),
        ]),
      ),
    ),
  ]);
});

export default Menu;
