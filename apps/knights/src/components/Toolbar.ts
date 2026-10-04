import {
  $,
  CLASS_NAME,
  attr,
  children,
  list,
  on,
  set,
  stylesheet,
  text,
  type Mountable,
} from "@apendua/justdom";
import { component, type Subscribable } from "@apendua/signal";
import { canPassThrough, passthrough, xrSession } from "@apendua.dev/headset/session";
import { ATTACKER } from "../constants";
import type Game from "../store/Game";
import { VERSUS_COMPUTER, type GameMode } from "../store/Root";
import ActionItem from "./ActionItem";
import branch from "./branch";
import { menuItem, menuItems } from "./styles";

interface ToolbarProps {
  game: Game | null;
  mode: GameMode;
  onMenuOpen?: () => void;
  onCreateNewGame?: () => Promise<unknown>;
}

const consoleBar = stylesheet`
  .${CLASS_NAME} {
    width: 100%;
    background: rgba(0, 0, 0, 0.5);
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
 * What only a session has, mounted while there is one and taken down when
 * it ends. Not hidden and shown: a panel measures the toolbar again when
 * its children change, and not when one of them is hidden.
 */
const inSession = (render: () => Subscribable<Mountable>) =>
  list(() => (xrSession.get() ? [true] : []), render);

/**
 * The bar along the bottom of the screen: the menu, a note on how the battle is
 * going, and the button that hands the turn over.
 *
 * Two things are there only in a headset session, mounted when the scene
 * says there is one: the passthrough switch, pressable only in a session
 * that can show the room, and the × at the end of the bar, which ends the
 * session.
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

  return $("div", [
    set("className", consoleBar),
    children(
      $("ul", [
        set("className", menuItems),
        children(
          $("li", [
            set("className", menuItem),
            on("click", () => props.onMenuOpen?.()),
            children(text`☰`),
          ]),
          label(() => (props.mode === VERSUS_COMPUTER ? "vs Computer" : "Hotseat")),
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
          $("li", [set("className", menuItem), attr({ "data-disabled": "" }), children(text`⚙`)]),
          inSession(() =>
            $("li", [
              set("className", menuItem),
              attr("data-disabled", () => (canPassThrough() ? undefined : "")),
              attr("data-inverted", () => (passthrough.get() && canPassThrough() ? "" : undefined)),
              on("click", () => {
                if (canPassThrough()) {
                  passthrough.set(!passthrough.get());
                }
              }),
              children(text`Passthrough`),
            ]),
          ),
          inSession(() =>
            $("li", [
              set("className", menuItem),
              attr({ title: "Leave the headset" }),
              on("click", () => {
                void xrSession.get()?.end();
              }),
              children(text`×`),
            ]),
          ),
        ),
      ]),
    ),
  ]);
});

export default Toolbar;
