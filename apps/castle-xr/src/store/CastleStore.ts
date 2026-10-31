/**
 * The castle: which bricks it is made of, where they are, and how to get back
 * to any of that.
 *
 * A brick's entry is a reactive store of its own, so moving one redraws that
 * brick and nothing else. Changes are recorded as what the brick looked like
 * before and after, which is enough to walk either way — the same trick
 * marblerun uses, and the reason placing, moving and removing all funnel
 * through here rather than touching the map directly.
 */
import * as THREE from "three";
import { batch, ReactiveMap, store } from "justdom-signal";
import { allBrickTypes, BrickType } from "../components/types.js";
import History from "./History.js";

export interface BrickState {
  type: BrickType;
  position: THREE.Vector3;
  rotation: THREE.Euler;
}

export interface StoredBrick {
  type: BrickType;
  position: [number, number, number];
  rotation: [number, number, number];
}

const STORAGE_KEY = "castle-xr:castle";
/**
 * What the key was called before the game was named. Read once so that a castle
 * built under the old name is still there after the rename; it can go as soon as
 * this has shipped anywhere.
 */
const LEGACY_STORAGE_KEY = "blocks-xr:castle";
const SAVE_DELAY = 300;

function toStored(brick: BrickState): StoredBrick {
  return {
    type: brick.type,
    position: [brick.position.x, brick.position.y, brick.position.z],
    rotation: [brick.rotation.x, brick.rotation.y, brick.rotation.z],
  };
}

function fromStored(brick: StoredBrick): BrickState {
  return {
    type: brick.type,
    position: new THREE.Vector3(...brick.position),
    rotation: new THREE.Euler(...brick.rotation),
  };
}

function copy(brick: BrickState): BrickState {
  return {
    type: brick.type,
    position: brick.position.clone(),
    rotation: brick.rotation.clone(),
  };
}

/** Anything that did not come out of this app is not worth trusting. */
function parseStored(raw: string): StoredBrick[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const bricks: StoredBrick[] = [];
  for (const entry of parsed) {
    const { type, position, rotation } = entry ?? {};
    if (!allBrickTypes.includes(type)) {
      continue;
    }
    if (!Array.isArray(position) || position.length !== 3) {
      continue;
    }
    if (!Array.isArray(rotation) || rotation.length !== 3) {
      continue;
    }
    if (![...position, ...rotation].every((value) => Number.isFinite(value))) {
      continue;
    }
    bricks.push({
      type,
      position: [position[0], position[1], position[2]],
      rotation: [rotation[0], rotation[1], rotation[2]],
    });
  }
  return bricks;
}

export default class CastleStore {
  readonly bricks = new ReactiveMap<string, BrickState>();
  readonly history = new History();

  #saveHandle: ReturnType<typeof setTimeout> | undefined;
  #counter = 0;

  /** The castle as it stood when the siege began, so it can be put back up. */
  #standing: StoredBrick[] = [];

  get size(): number {
    return this.bricks.size;
  }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        this.restore(parseStored(raw));
      }
    } catch (error) {
      console.warn("Could not read the saved castle:", error);
    }
  }

  place(brick: BrickState): string {
    const id = `brick-${this.#counter++}-${Math.round(Math.random() * 1e6)}`;
    this.bricks.set(id, store<BrickState>(copy(brick)));
    this.history.record({
      undo: () => this.#restoreOne(id, null),
      redo: () => this.#restoreOne(id, copy(brick)),
    });
    this.save();
    return id;
  }

  move(id: string, position: THREE.Vector3, rotation: THREE.Euler): void {
    const brick = this.bricks.get(id);
    if (!brick) {
      return;
    }
    const before = copy(brick);
    batch(() => {
      brick.position = position.clone();
      brick.rotation = rotation.clone();
    });
    const after = copy(brick);
    this.history.record({
      undo: () => this.#restoreOne(id, before),
      redo: () => this.#restoreOne(id, after),
    });
    this.save();
  }

  remove(id: string): void {
    const brick = this.bricks.get(id);
    if (!brick) {
      return;
    }
    const before = copy(brick);
    this.bricks.delete(id);
    this.history.record({
      undo: () => this.#restoreOne(id, before),
      redo: () => this.#restoreOne(id, null),
    });
    this.save();
  }

  clear(): void {
    const before = this.serialize();
    this.bricks.clear();
    this.history.record({
      undo: () => this.restore(before),
      redo: () => this.bricks.clear(),
    });
    this.save();
  }

  serialize(): StoredBrick[] {
    return Array.from(this.bricks.values()).map(toStored);
  }

  restore(bricks: StoredBrick[]): void {
    batch(() => {
      this.bricks.clear();
      for (const brick of bricks) {
        this.bricks.set(`brick-${this.#counter++}`, store<BrickState>(fromStored(brick)));
      }
    });
    this.save();
  }

  /**
   * Remembers the castle as built. Physics moves the bricks around from here
   * on, and what the player wants back afterwards is the castle they made, not
   * the rubble it became.
   */
  rememberStanding(): void {
    this.#standing = this.serialize();
  }

  restoreStanding(): void {
    this.restore(this.#standing);
    this.history.clear();
  }

  save(): void {
    if (this.#saveHandle) {
      clearTimeout(this.#saveHandle);
    }
    this.#saveHandle = setTimeout(() => {
      this.#saveHandle = undefined;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize()));
      } catch (error) {
        console.warn("Could not save the castle:", error);
      }
    }, SAVE_DELAY);
  }

  #restoreOne(id: string, state: BrickState | null): void {
    batch(() => {
      if (!state) {
        this.bricks.delete(id);
        return;
      }
      const existing = this.bricks.get(id);
      if (existing) {
        // Moved back rather than replaced, so whatever is drawing this brick
        // keeps the object it already has.
        existing.position = state.position.clone();
        existing.rotation = state.rotation.clone();
        return;
      }
      this.bricks.set(id, store<BrickState>(copy(state)));
    });
    this.save();
  }
}
