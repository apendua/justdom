/**
 * Where the game is up to. Two phases and the handful of numbers the panel
 * shows; everything that is actually in the world lives elsewhere.
 */
import { Signal } from "@apendua.dev/signal";

export type Phase = "build" | "siege";

/** Which hand holds the fork. The other one pulls the pouch. */
export type ForkHand = "left" | "right";

export default class Session {
  readonly phase = Signal.of<Phase>("build");
  readonly forkHand = Signal.of<ForkHand>("left");
  /**
   * Hold the slingshot out in front of the head rather than in a hand. Meant
   * for playing at a desk through the emulator, where the head follows the
   * mouse but the hands have to be dragged into place one at a time.
   */
  readonly gazeAim = Signal.of(false);
  readonly shots = Signal.of(0);
  /** Bricks that are still up off the ground. */
  readonly standing = Signal.of(0);
  readonly total = Signal.of(0);
  readonly won = Signal.of(false);

  beginSiege(): void {
    this.shots.set(0);
    this.won.set(false);
    this.phase.set("siege");
  }

  beginBuilding(): void {
    this.won.set(false);
    this.standing.set(0);
    this.phase.set("build");
  }

  swapHands(): void {
    this.forkHand.setFn((hand) => (hand === "left" ? "right" : "left"));
  }

  toggleGazeAim(): void {
    this.gazeAim.setFn((value) => !value);
  }
}
