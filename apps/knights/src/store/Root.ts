import { batch, createProperty, mutate, store } from "@apendua.dev/signal";
import { MAP_COLUMNS, MAP_ROWS } from "../constants";
import { generateGame } from "../helpers/generators";
import { randomId } from "../helpers/random";
import Game from "./Game";

const COOKIE_NAME = "userId";
const COOKIE_MAX_AGE = 1000 * 3600 * 24 * 7; // 7 days

/**
 * The time it takes to "create" a game. The original project asked a server for
 * a new game; here the map is generated locally, and the delay is kept so that
 * the spinner in the menu still has something to spin for.
 */
const CREATE_GAME_DELAY = 500;

interface RootState {
  userId: string;
  hasCookie: boolean;
  game: Game | null;
}

/**
 * Everything that outlives a single game: who is playing, and which game is
 * currently on the board.
 */
export default class Root {
  #state: RootState;

  public constructor() {
    const userId = readUserIdCookie();
    this.#state = store<RootState>({
      // Without a cookie the player still gets an id, it just does not survive
      // a reload. That keeps the board playable while the consent notice is up.
      userId: userId || randomId(),
      hasCookie: !!userId,
      game: null,
    });
  }

  public get userId(): string {
    return this.#state.userId;
  }

  /**
   * True once the player has agreed to have their id stored.
   */
  public get hasCookie(): boolean {
    return this.#state.hasCookie;
  }

  public get game(): Game | null {
    return this.#state.game;
  }

  /**
   * Generate a fresh map and put it on the board. Both teams are handed to the
   * same player, so the game is playable on its own.
   */
  public createNewGame(): Promise<string> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const gameId = randomId();
        batch(() => {
          this.#state.game?.dispose();
          this.#state.game = new Game(generateGame(MAP_ROWS, MAP_COLUMNS), {
            gameId,
            userId: this.#state.userId,
            onePlayer: true,
          });
        });
        resolve(gameId);
      }, CREATE_GAME_DELAY);
    });
  }

  /**
   * Remember the current player id, so that the same player comes back after a
   * reload.
   */
  @mutate()
  public acceptCookies(): void {
    const expires = new Date(Date.now() + COOKIE_MAX_AGE).toUTCString();
    document.cookie = `${COOKIE_NAME}=${this.#state.userId};expires=${expires}`;
    this.#state.hasCookie = true;
  }
}

function readUserIdCookie(): string {
  for (const chunk of document.cookie.split(/\s*;\s*/)) {
    const [name, value] = chunk.split("=");
    if (name === COOKIE_NAME) {
      return value ?? "";
    }
  }
  return "";
}

export const RootContext = createProperty(() => new Root());
