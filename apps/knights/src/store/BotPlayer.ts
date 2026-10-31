import { Derived, Effect, onCleanup } from "@apendua/signal";
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
  #effect: Effect;

  public constructor(game: Game, thinkingTime = TIMING_BOT_THINKS) {
    // The `Derived` is the cutoff: `isWaitingForBot` is a plain getter over
    // several pieces of game state, and only the answer it computes should be
    // able to restart the pause below.
    const isWaiting = new Derived(() => game.isWaitingForBot);
    this.#effect = new Effect(() => {
      if (!isWaiting.get()) {
        return;
      }
      const handle = setTimeout(() => {
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
      }, thinkingTime);
      // A board that stops waiting mid-pause — the game ends, the player takes
      // the side over — drops the move that was being thought about.
      onCleanup(() => clearTimeout(handle));
    });
  }

  public dispose(): void {
    this.#effect.dispose();
  }
}
