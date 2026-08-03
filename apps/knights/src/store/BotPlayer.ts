import { observable } from "@apendua/signal";
import { EMPTY, switchMap, timer, type Subscription } from "rxjs";
import { TIMING_BOT_THINKS } from "../constants";
import chooseMove from "./bot";
import type Game from "./Game";

/**
 * Plays the computer's side of a game.
 *
 * It watches for the board to be waiting on it rather than being told when its
 * turn comes round: `isWaitingForBot` is derived from the game's state, so it
 * flips on its own once a move has played out and the turn moves along. The
 * pause in between is what stops the whole enemy army from playing out in a
 * single blur.
 */
export default class BotPlayer {
  #subscription: Subscription;

  public constructor(game: Game, thinkingTime = TIMING_BOT_THINKS) {
    this.#subscription = observable(() => game.isWaitingForBot)
      .pipe(switchMap((isWaiting) => (isWaiting ? timer(thinkingTime) : EMPTY)))
      .subscribe(() => {
        const actor = game.currentActor;
        if (!actor) {
          return;
        }
        const move = chooseMove(game, actor);
        if (move) {
          game.moveActor(move.actor, move.path, move.opponent);
        } else {
          // Nothing worth doing — hand the turn along rather than stalling.
          game.nextActor();
        }
      });
  }

  public dispose(): void {
    this.#subscription.unsubscribe();
  }
}
