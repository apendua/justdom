import {
  $,
  CLASS_NAME,
  attr,
  children,
  on,
  renderText,
  set,
  stylesheet,
  text,
} from "@apendua/justdom";
import { component } from "@apendua/signal";
import { HOTSEAT, VERSUS_COMPUTER, type GameMode } from "../store/Root";
import ActionItem from "./ActionItem";
import { menuItem, modal, modalFill } from "./styles";

interface MenuModalProps {
  isVisible: boolean;
  onClose?: () => void;
  onCreateNewGame?: (mode: GameMode) => Promise<unknown>;
}

const backdrop = stylesheet`
  .${CLASS_NAME} {
    background: rgba(0, 0, 0, 0.9);
  }
`;

const menuList = stylesheet`
  .${CLASS_NAME} {
    --menu-item-size: 5vw;
    --menu-item-border: 1px solid white;
    flex-grow: 0;
    list-style: none;
    width: 50vw;
    margin: auto;
    padding: 0;
  }
`;

/**
 * The full screen menu behind the hamburger button, and the only place the two
 * ways of playing are chosen.
 */
const MenuModal = component((ctx: WeakKey, props: MenuModalProps) => {
  const newGame = (title: string, mode: GameMode) =>
    ActionItem(ctx, {
      title,
      action: () => props.onCreateNewGame?.(mode),
      onReady: () => props.onClose?.(),
    });

  return $("div", [
    set("className", renderText`${modal} ${backdrop}`),
    attr("hidden", () => (props.isVisible ? undefined : "")),
    children(
      $("div", [set("className", modalFill)]),
      $("ul", [
        set("className", menuList),
        children(
          newGame("New Game vs Computer", VERSUS_COMPUTER),
          newGame("New Game — Hotseat", HOTSEAT),
          $("li", [
            set("className", menuItem),
            on("click", () => props.onClose?.()),
            children(text`Continue`),
          ]),
        ),
      ]),
      $("div", [set("className", modalFill)]),
    ),
  ]);
});

export default MenuModal;
