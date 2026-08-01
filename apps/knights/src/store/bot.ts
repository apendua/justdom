import {
  createMapOfDistances,
  createMapOfObstacles,
  findPathTo,
  generateFields,
  getMapValue,
} from "../helpers/map";
import { createNeighborsGenerator } from "../helpers/neighbors";
import type { FieldCoords } from "../types";
import type Actor from "./Actor";
import type Game from "./Game";

/**
 * What finishing a stack off is worth. It is large enough to outweigh any
 * ordinary trade, because a stack that is gone never swings again.
 */
const KILL_BONUS = 100;

/**
 * How much walking is worth avoiding. Small — it only settles ties between
 * targets that are otherwise equally good.
 */
const STEP_PENALTY = 0.5;

/**
 * How much more the damage dealt counts than the damage taken. Above one, so
 * the computer stays willing to trade, but not blindly.
 */
const AGGRESSION = 2;

export interface BotMove {
  actor: Actor;
  path: FieldCoords[];
  opponent?: Actor;
}

/**
 * What a stack would get out of walking up to the given enemy and hitting it.
 *
 * The damage is what it deals, less what the survivors deal back — a stack that
 * has lost units hits for less, so wiping one out is worth much more than the
 * damage alone suggests.
 */
function scoreAttack(actor: Actor, enemy: Actor, steps: number): number {
  const damage = Math.min(actor.attackPower, enemy.totalHealth);
  const remainingHealth = enemy.totalHealth - damage;
  const counterAttack =
    remainingHealth > 0 ? enemy.strength * Math.ceil(remainingHealth / enemy.toughness) : 0;

  return (
    AGGRESSION * damage -
    counterAttack +
    (remainingHealth === 0 ? KILL_BONUS : 0) -
    STEP_PENALTY * steps
  );
}

/**
 * Decide what a stack should do with its turn.
 *
 * The heuristics are deliberately shallow — one turn deep, no idea what the
 * opponent will do next:
 *
 * 1. Of everything it can reach and hit this turn, take the best trade.
 * 2. Failing that, walk as far as it can toward the enemy it can most nearly
 *    reach.
 * 3. Failing that too, stand still.
 *
 * Returns `null` when there is nothing worth doing, which the caller should
 * read as passing the turn.
 */
export default function chooseMove(game: Game, actor: Actor): BotMove | null {
  if (!actor.isAlive) {
    return null;
  }
  const neighborsGenerator = createNeighborsGenerator(game.nRows, game.nColumns);
  // The stack being moved is not in its own way, but everybody else is.
  const blocked = createMapOfObstacles(
    game.nRows,
    game.nColumns,
    game.obstacles,
    game.actors.filter((candidate) => candidate.isAlive && candidate !== actor),
  );
  const distances = createMapOfDistances(game.nRows, game.nColumns, actor, blocked);
  const enemies = game.actors.filter(
    (candidate) => candidate.isAlive && candidate.side !== actor.side,
  );

  if (enemies.length === 0) {
    return null;
  }

  // 1. The best trade available this turn.
  let bestScore = -Infinity;
  let bestAttack: BotMove | null = null;

  for (const enemy of enemies) {
    for (const field of neighborsGenerator(enemy)) {
      const steps = getMapValue(field, distances) ?? Infinity;
      if (steps > actor.speed) {
        continue;
      }
      const score = scoreAttack(actor, enemy, steps);
      if (score > bestScore) {
        bestScore = score;
        bestAttack = {
          actor,
          path: findPathTo(field, neighborsGenerator, distances),
          opponent: enemy,
        };
      }
    }
  }
  if (bestAttack && bestAttack.path.length > 0) {
    return bestAttack;
  }

  // 2. Nothing within reach, so close the distance instead. The enemy to head
  //    for is the one whose doorstep is the fewest steps away.
  let target: Actor | null = null;
  let targetDistance = Infinity;

  for (const enemy of enemies) {
    for (const field of neighborsGenerator(enemy)) {
      const steps = getMapValue(field, distances) ?? Infinity;
      if (steps < targetDistance) {
        targetDistance = steps;
        target = enemy;
      }
    }
  }
  if (!target || !Number.isFinite(targetDistance)) {
    // Walled in, or the enemy is. Nothing to be done about it this turn.
    return null;
  }

  const distancesToTarget = createMapOfDistances(game.nRows, game.nColumns, target, blocked);
  let bestField: FieldCoords | null = null;
  let bestRemaining = Infinity;
  let bestSteps = Infinity;

  for (const field of generateFields(game.nRows, game.nColumns)) {
    const steps = getMapValue(field, distances) ?? Infinity;
    if (steps > actor.speed) {
      continue;
    }
    const remaining = getMapValue(field, distancesToTarget) ?? Infinity;
    if (remaining < bestRemaining || (remaining === bestRemaining && steps < bestSteps)) {
      bestRemaining = remaining;
      bestSteps = steps;
      bestField = field;
    }
  }
  // Standing still is not a move, and neither is a path of a single field with
  // nobody to hit at the end of it.
  if (!bestField || bestSteps === 0) {
    return null;
  }
  const path = findPathTo(bestField, neighborsGenerator, distances);
  return path.length > 1 ? { actor, path } : null;
}
