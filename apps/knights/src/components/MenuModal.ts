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
} from "@apendua.dev/dom";
import { component } from "@apendua.dev/signal";
import ActionItem from "./ActionItem";
import { menuItem, modal, modalFill } from "./styles";

interface MenuModalProps {
  isVisible: boolean;
  onClose?: () => void;
  onCreateNewGame?: () => Promise<unknown>;
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
 * The full screen menu behind the hamburger button.
 */
const MenuModal = component((ctx: WeakKey, props: MenuModalProps) => {
  return $("div", [
    set("className", renderText`${modal} ${backdrop}`),
    attr("hidden", () => (props.isVisible ? undefined : "")),
    children(
      $("div", [set("className", modalFill)]),
      $("ul", [
        set("className", menuList),
        children(
          ActionItem(ctx, {
            title: "Create New Game",
            action: () => props.onCreateNewGame?.(),
            onReady: () => props.onClose?.(),
          }),
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
