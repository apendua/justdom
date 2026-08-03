import { batch, createProperty, store } from "@apendua/signal";
import { ATTACKER, COMPUTER, DEFENDER, HUMAN, MAP_COLUMNS, MAP_ROWS } from "../constants";
import { generateGame } from "../helpers/generators";
import { randomId } from "../helpers/random";
import BotPlayer from "./BotPlayer";
import Game from "./Game";

/**
 * The time it takes to "create" a game. The original project asked a server for
 * a new game; here the map is generated locally, and the delay is kept so that
 * the spinner in the menu still has something to spin for.
 */
const CREATE_GAME_DELAY = 500;

/**
 * Who is playing. Against the computer the player takes the attacking army;
 * in a hotseat game they give the orders for both.
 */
export const VERSUS_COMPUTER = "VERSUS_COMPUTER";
export const HOTSEAT = "HOTSEAT";

export type GameMode = typeof VERSUS_COMPUTER | typeof HOTSEAT;

const controllersByMode = {
  [VERSUS_COMPUTER]: { [ATTACKER]: HUMAN, [DEFENDER]: COMPUTER },
  [HOTSEAT]: { [ATTACKER]: HUMAN, [DEFENDER]: HUMAN },
} as const;

interface RootState {
  game: Game | null;
  mode: GameMode;
}

/**
 * Everything that outlives a single game: which game is currently on the board,
 * and who is playing it.
 */
export default class Root {
  #state = store<RootState>({ game: null, mode: VERSUS_COMPUTER });
  #bot: BotPlayer | null = null;

  public get game(): Game | null {
    return this.#state.game;
  }

  public get mode(): GameMode {
    return this.#state.mode;
  }

  /**
   * Generate a fresh map and put it on the board, keeping the mode that is
   * already being played unless a new one is asked for.
   */
  public createNewGame(mode: GameMode = this.#state.mode): Promise<string> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const gameId = randomId();
        const game = new Game(generateGame(MAP_ROWS, MAP_COLUMNS), {
          gameId,
          controllers: controllersByMode[mode],
        });
        batch(() => {
          this.#bot?.dispose();
          this.#state.game?.dispose();
          this.#state.mode = mode;
          this.#state.game = game;
        });
        this.#bot = mode === VERSUS_COMPUTER ? new BotPlayer(game) : null;
        resolve(gameId);
      }, CREATE_GAME_DELAY);
    });
  }
}

export const RootContext = createProperty(() => new Root());
