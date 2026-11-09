import { $, CLASS_NAME, attr, children, on, renderText, set, stylesheet, text } from "justdom-core";
import { component } from "justdom-signal";
import { HOTSEAT, VERSUS_COMPUTER, type GameMode } from "../store/Root";
import { narrow } from "../viewport";
import ActionItem from "./ActionItem";
import { menuItem, modal, modalFill } from "./styles";
import { LeaveItem, PassthroughItem, inSession, modeName, mountedWhile } from "./toolbarItems";

interface MenuModalProps {
  isVisible: boolean;
  mode: GameMode;
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
    --menu-item-size: max(40px, 5vw);
    --menu-item-border: 1px solid white;
    flex-grow: 0;
    /* One item under another, each the width of the list. An item is an
       inline block, which is right in the toolbar and lined the three up
       here as far as they fitted. */
    display: flex;
    flex-direction: column;
    list-style: none;
    width: 50vw;
    min-width: min(320px, calc(100vw - 32px));
    margin: auto;
    padding: 0;
  }
`;

/**
 * The full screen menu behind the hamburger button, and the only place the two
 * ways of playing are chosen.
 *
 * On a narrow page it also holds what the toolbar has no room for: the way
 * the battle is being played and, in a headset session, the passthrough
 * switch and the way out.
 */
const MenuModal = component((ctx: WeakKey, props: MenuModalProps) => {
  const newGame = (title: string, mode: GameMode) =>
    ActionItem(ctx, {
      title,
      action: () => props.onCreateNewGame?.(mode),
      onReady: () => props.onClose?.(),
    });

  const narrowSession = () => narrow.get() && inSession();

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
          mountedWhile(
            () => narrow.get(),
            () =>
              $("li", [
                set("className", menuItem),
                attr({ "data-readonly": "" }),
                children(text`Playing ${() => modeName(props.mode)}`),
              ]),
          ),
          mountedWhile(narrowSession, PassthroughItem),
          mountedWhile(narrowSession, () =>
            LeaveItem("Leave the headset", () => props.onClose?.()),
          ),
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
