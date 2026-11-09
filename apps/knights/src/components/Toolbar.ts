import { $, CLASS_NAME, attr, children, on, set, stylesheet, text } from "justdom-core";
import { component } from "justdom-signal";
import { xrSession } from "justdom-xr/session";
import { ATTACKER } from "../constants";
import type Game from "../store/Game";
import type { GameMode } from "../store/Root";
import { narrow } from "../viewport";
import ActionItem from "./ActionItem";
import branch from "./branch";
import { menuItem, menuItems } from "./styles";
import { LeaveItem, PassthroughItem, modeName, mountedWhile } from "./toolbarItems";

interface ToolbarProps {
  game: Game | null;
  mode: GameMode;
  onMenuOpen?: () => void;
  onCreateNewGame?: () => Promise<unknown>;
}

/**
 * On a narrow page the buttons are a fixed size and closer together, since
 * a phone held upright is tall enough to make them as wide as the screen.
 */
const consoleBar = stylesheet`
  .${CLASS_NAME} {
    width: 100%;
    background: rgba(0, 0, 0, 0.5);
  }

  .${CLASS_NAME}[data-narrow] {
    --menu-item-size: 40px;
    --menu-item-padding: 0.4;
  }
`;

/**
 * What the middle of the toolbar has to say about the game: who won, whose turn
 * it is, or an invitation to start one.
 */
function mainSlot(game: Game | null): "create" | "over" | "skip" | "waiting" | "play" {
  if (!game) {
    return "create";
  }
  if (game.isOver) {
    return "over";
  }
  // An animation can be cut short whoever is playing it out — waiting on the
  // computer's knights to finish walking is no more interesting than waiting on
  // your own.
  if (game.actorHasMoved) {
    return "skip";
  }
  return game.isControlledByHuman ? "play" : "waiting";
}

/**
 * The bar along the bottom of the screen: the menu, a note on how the battle is
 * going, and the button that hands the turn over.
 *
 * Two things are there only in a headset session, mounted when the scene
 * says there is one: the passthrough switch, pressable only in a session
 * that can show the room, and the × at the end of the bar, which ends the
 * session.
 *
 * On a narrow page the bar keeps only ☰, the main button and the round. The
 * way of playing and the two session items move into the menu behind ☰,
 * and the ⚙, which does nothing yet, is left out.
 */
const Toolbar = component((ctx: WeakKey, props: ToolbarProps) => {
  const handleMainButton = () => {
    const { game } = props;
    if (!game || game.isOver) {
      return;
    }
    if (game.actorHasMoved) {
      // The stack is still playing out its move; let the player cut it short.
      game.skipAnimation();
    } else if (game.isControlledByHuman) {
      game.nextActor();
    }
  };

  /**
   * A stretch of hatched bar. It fills the space the team chooser used to take
   * up, and carries a caption when there is one worth showing.
   */
  const label = (caption: () => string) =>
    $("li", [
      set("className", menuItem),
      attr({ "data-fill": "", "data-readonly": "" }),
      children(text`${caption}`),
    ]);

  const wide = () => !narrow.get();

  return $("div", [
    set("className", consoleBar),
    attr("data-narrow", () => (narrow.get() ? "" : undefined)),
    children(
      $("ul", [
        set("className", menuItems),
        children(
          $("li", [
            set("className", menuItem),
            on("click", () => props.onMenuOpen?.()),
            children(text`☰`),
          ]),
          mountedWhile(wide, () => label(() => modeName(props.mode))),
          branch(
            () => mainSlot(props.game),
            (key) => {
              if (key === "create") {
                return ActionItem(ctx, {
                  title: "Create New Game",
                  action: () => props.onCreateNewGame?.(),
                });
              }
              if (key === "over") {
                return $("li", [
                  set("className", menuItem),
                  attr({ "data-readonly": "" }),
                  children(
                    text`${() => (props.game?.winner === ATTACKER ? "White wins" : "Black wins")}`,
                  ),
                ]);
              }
              if (key === "waiting") {
                return $("li", [
                  set("className", menuItem),
                  attr({ "data-readonly": "" }),
                  children(text`Thinking…`),
                ]);
              }
              return $("li", [
                set("className", menuItem),
                on("click", handleMainButton),
                children(text`${key === "skip" ? "Skip" : "Continue"}`),
              ]);
            },
          ),
          label(() => (props.game ? `Round ${props.game.currentRound + 1}` : "")),
          mountedWhile(wide, () =>
            $("li", [set("className", menuItem), attr({ "data-disabled": "" }), children(text`⚙`)]),
          ),
          mountedWhile(() => wide() && xrSession.get() !== null, PassthroughItem),
          mountedWhile(
            () => wide() && xrSession.get() !== null,
            () => LeaveItem("×"),
          ),
        ),
      ]),
    ),
  ]);
});

export default Toolbar;
