import type { ActorType, Side } from "./constants";
import type { FieldCoords } from "./helpers/neighbors";

export type { FieldCoords };

/**
 * The plain description of an actor, as produced by the game generator. It's
 * everything that is needed to bring an `Actor` to life.
 */
export interface ActorSetup extends FieldCoords {
  type: ActorType;
  side: Side;
  amount: number;
  speed: number;
  strength: number;
  toughness: number;
}

/**
 * The plain description of a game, as produced by the game generator.
 */
export interface GameSetup {
  nRows: number;
  nColumns: number;
  obstacles: FieldCoords[];
  actors: ActorSetup[];
}
