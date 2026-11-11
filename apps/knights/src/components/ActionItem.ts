import { $, attr, branch, children, on, set, text } from "justdom-core";
import { component, store } from "justdom-signal";
import { menuItem, spinner } from "./styles";

interface ActionItemProps {
  title: string;
  /**
   * Runs when the item is clicked. If it returns a promise, the item spins
   * until the promise settles and only then reports back.
   */
  action?: () => unknown;
  onReady?: () => void;
}

/**
 * A menu item that stands for something that takes a while — creating a new
 * game, in practice. It refuses to be clicked again while it is still waiting.
 */
const ActionItem = component((_: WeakKey, props: ActionItemProps) => {
  const state = store({ isWaiting: false });

  const setWaiting = (isWaiting: boolean) => {
    state.isWaiting = isWaiting;
  };

  const handleClick = () => {
    if (state.isWaiting) {
      return;
    }
    const result = props.action?.();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      setWaiting(true);
      Promise.resolve(result).then(() => {
        setWaiting(false);
        props.onReady?.();
      });
    }
  };

  return $("li", [
    set("className", menuItem),
    attr("data-disabled", () => (state.isWaiting ? "" : undefined)),
    on("click", handleClick),
    children(
      branch(
        () => (state.isWaiting ? "waiting" : "ready"),
        (key) =>
          key === "waiting"
            ? $("span", [set("className", spinner), children(text`◴`)])
            : $("span", [children(text`${() => props.title}`)]),
      ),
    ),
  ]);
});

export default ActionItem;
