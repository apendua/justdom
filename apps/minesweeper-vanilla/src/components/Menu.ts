import { $, attr, children, className, on, style, text } from "@apendua.dev/dom";
import { Fields } from "@apendua.dev/minesweeper";
import { component } from "@apendua.dev/signal";

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

const bar = className`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(6px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
`;

const presetGroup = className`
  display: flex;
  gap: 4px;
  background: #e9ecef;
  border-radius: 8px;
  padding: 4px;
`;

const presetButton = className`
  border: none;
  background: transparent;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
`;

const counter = className`
  display: flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
  font-family: 'Courier New', Consolas, monospace;
  font-weight: 700;
  font-size: 16px;
  background: #212529;
  color: #ff6b6b;
  padding: 6px 12px;
  border-radius: 6px;
  min-width: 44px;
  justify-content: center;
`;

const restartButton = className`
  border: none;
  background: #343a40;
  color: white;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
`;

const statusBadge = className`
  padding: 7px 14px;
  border-radius: 8px;
  font-weight: 700;
  font-size: 13px;
  transition: background-color 0.15s ease, color 0.15s ease;
`;

const Menu = component((_ctx: WeakKey, props: MenuProps) => {
  return $("div", [
    attr("class", bar),
    children(
      $("div", [
        attr("class", presetGroup),
        children(
          ...props.presets.map((preset) =>
            $("button", [
              attr("class", presetButton),
              attr("type", () => "button"),
              style("background", () =>
                preset.id === props.selectedId ? "#2f9e44" : "transparent",
              ),
              style("color", () => (preset.id === props.selectedId ? "#ffffff" : "#495057")),
              on("click", () => props.onSelect(preset)),
              children(text`${preset.label}`),
            ]),
          ),
        ),
      ]),
      $("div", [attr("class", counter), children(text`${() => props.game.minesLeft}`)]),
      $("button", [
        attr("class", restartButton),
        attr("type", () => "button"),
        on("click", () => props.onRestart()),
        children(text`Restart`),
      ]),
      $("div", [
        attr("class", statusBadge),
        style("background", () => {
          if (props.game.isWon) return "#2f9e44";
          if (props.game.isLost) return "#e03131";
          return "transparent";
        }),
        style("color", () => (props.game.isGameOver ? "#ffffff" : "#adb5bd")),
        children(
          text`${() => {
            if (props.game.isWon) return "You win!";
            if (props.game.isLost) return "Game over";
            return "Good luck!";
          }}`,
        ),
      ]),
    ),
  ]);
});

export default Menu;
