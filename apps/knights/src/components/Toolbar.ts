import { $, CLASS_NAME, attr, children, on, set, stylesheet, text } from "@apendua.dev/dom";
import { component } from "@apendua.dev/signal";
import type Game from "../store/Game";
import ActionItem from "./ActionItem";
import branch from "./branch";
import { menuItem, menuItems } from "./styles";

interface ToolbarProps {
  game: Game | null;
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
 * The bar along the bottom of the screen: the menu, the team chooser, and the
 * button that hands the turn over.
 */
const Toolbar = component((ctx: WeakKey, props: ToolbarProps) => {
  const isActive = () => !!props.game?.isControlledByUser;

  const handleMainButton = () => {
    const { game } = props;
    if (!game || !game.isControlledByUser) {
      return;
    }
    if (game.actorHasMoved) {
      // The stack is still playing out its move; let the player cut it short.
      game.skipAnimation();
    } else if (game.hasStarted) {
      game.nextActor();
    } else {
      game.startGame();
    }
  };

  /**
   * One half of the team chooser. It is gone once both teams are taken, which
   * is immediately in a one player game.
   */
  const teamChooser = (label: string, claimedId: () => string, claim: () => void, white: boolean) =>
    branch(
      () => {
        const { game } = props;
        if (!game || (game.attackerId && game.defenderId)) {
          return "hidden" as const;
        }
        return claimedId() ? ("taken" as const) : ("open" as const);
      },
      (key) => {
        if (key === "open") {
          return $("li", [
            set("className", menuItem),
            attr({ "data-fill": "" }),
            attr("data-inverted", () => (white ? "" : undefined)),
            on("click", claim),
            children(text`${label}`),
          ]);
        }
        return $("li", [
          set("className", menuItem),
          attr({ "data-fill": "", "data-disabled": "" }),
          children(text`${key === "taken" ? label : ""}`),
        ]);
      },
    );

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
          teamChooser(
            "Choose white",
            () => props.game?.attackerId ?? "",
            () => props.game?.claimAttackingTeam(props.game.userId),
            true,
          ),
          // The middle slot is where a game gets created, and once both teams
          // are taken, where turns are handed over.
          branch(
            () => {
              const { game } = props;
              if (!game) {
                return "create" as const;
              }
              return game.attackerId && game.defenderId ? ("play" as const) : ("none" as const);
            },
            (key) => {
              if (key === "create") {
                return ActionItem(ctx, {
                  title: "Create New Game",
                  action: () => props.onCreateNewGame?.(),
                });
              }
              if (key === "none") {
                return text``;
              }
              return $("li", [
                set("className", menuItem),
                attr("data-disabled", () => (isActive() ? undefined : "")),
                on("click", handleMainButton),
                children(text`${() => (props.game?.hasStarted ? "Continue" : "Start game")}`),
              ]);
            },
          ),
          teamChooser(
            "Choose black",
            () => props.game?.defenderId ?? "",
            () => props.game?.claimDefendingTeam(props.game.userId),
            false,
          ),
          $("li", [set("className", menuItem), attr({ "data-disabled": "" }), children(text`⚙`)]),
        ),
      ]),
    ),
  ]);
});

export default Toolbar;
