import { $$, attr, children } from "@apendua/justdom";
import {
  component,
  Derived,
  each,
  effects,
  memo,
  mutate,
  store,
  use,
  useEffect,
} from "@apendua/signal";
import {
  ASSETS_PREFIX,
  animationsDb,
  type ActorType,
  type AnimationType,
  type Frame,
  type SpriteSheet,
} from "../constants";
import { randomId } from "../helpers/random";
import { frames as clock } from "../store/clock";

interface SpriteProps {
  actorType: ActorType;
  animation: AnimationType;
  positionX: number;
  positionY: number;
  direction: number;
  height: number;
  forceLoop?: boolean;
}

interface AnimationSetup extends SpriteSheet {
  frames: Frame[];
  direction: number;
  isLoop: boolean;
}

interface SpriteGeometry {
  source: string;
  /** Where the top left corner of the current frame lands on the canvas. */
  x: number;
  y: number;
  spriteWidth: number;
  spriteHeight: number;
  imageWidth: number;
  imageHeight: number;
  frameOffsetX: number;
  frameOffsetY: number;
  mirror: boolean;
}

/**
 * Pick the sheet and the strip of frames that play the given animation in the
 * given direction. Sheets only hold one of every mirrored pair, so a direction
 * is matched by its absolute value and the sprite is flipped when drawing.
 */
function getAnimationSetup(
  actorType: ActorType,
  animation: AnimationType,
  direction: number,
): AnimationSetup | null {
  const entry = animationsDb[actorType];
  if (!entry) {
    return null;
  }
  // NOTE: We may have more matching conditions later on.
  const firstMatch = entry.animations.find((data) => data.type === animation);
  if (!firstMatch) {
    return null;
  }
  const directionMatch = firstMatch.variants.find(
    (variant) => variant.direction === Math.abs(direction),
  );
  if (!directionMatch) {
    return null;
  }
  const sheet = entry.sheets[firstMatch.sheetIdx ?? 0];
  if (!sheet) {
    return null;
  }
  return { ...sheet, ...directionMatch, isLoop: !!firstMatch.isLoop };
}

class SpriteStore {
  #props: SpriteProps;
  #state = store({ currentFrame: 0 });
  /**
   * Looping animations start at a random frame, so that a row of identical
   * knights doesn't breathe in unison.
   */
  #frameOffset = Math.floor(100 * Math.random());

  public constructor(props: SpriteProps) {
    this.#props = props;
  }

  @memo()
  public get setup(): AnimationSetup | null {
    return getAnimationSetup(this.#props.actorType, this.#props.animation, this.#props.direction);
  }

  /**
   * Identifies the animation being played. Turning on the spot swaps the strip
   * of frames but keeps playback going, so the direction is deliberately left
   * out of it.
   */
  public get animationKey(): string {
    return `${this.#props.actorType}:${this.#props.animation}`;
  }

  @mutate()
  public rewind(): void {
    this.#state.currentFrame = 0;
  }

  /**
   * Advance one frame. Animations that don't loop simply hold their last frame.
   */
  @mutate()
  public nextFrame(): void {
    const setup = this.setup;
    if (!setup) {
      return;
    }
    if (this.#state.currentFrame >= setup.frames.length - 1) {
      if (this.#props.forceLoop || setup.isLoop) {
        this.#state.currentFrame = 0;
      }
    } else {
      this.#state.currentFrame += 1;
    }
  }

  @memo()
  public get geometry(): SpriteGeometry | null {
    const setup = this.setup;
    if (!setup || setup.frames.length === 0) {
      // NOTE: It means that there's no animation at all.
      return null;
    }
    const { direction, positionX, positionY, height } = this.#props;

    let currentFrame = this.#state.currentFrame;
    if (setup.isLoop || this.#props.forceLoop) {
      currentFrame = (currentFrame + this.#frameOffset) % setup.frames.length;
    }
    const frame = setup.frames[currentFrame];

    const mirror = setup.direction !== direction;
    const scale = height / setup.actorHeight;

    const spriteOffsetX = mirror
      ? scale * (setup.frameWidth - setup.offsetX)
      : scale * setup.offsetX;
    const spriteOffsetY = scale * setup.offsetY;
    const spriteWidth = scale * setup.frameWidth;
    const spriteHeight = scale * setup.frameHeight;

    return {
      source: ASSETS_PREFIX + setup.source,
      x: positionX - spriteOffsetX,
      y: positionY - spriteOffsetY,
      spriteWidth,
      spriteHeight,
      imageWidth: setup.nColumns * spriteWidth,
      imageHeight: setup.nRows * spriteHeight,
      frameOffsetX: frame[1] * spriteWidth,
      frameOffsetY: frame[0] * spriteHeight,
      mirror,
    };
  }
}

/**
 * Draws one frame of a sprite sheet.
 *
 * The whole sheet is placed as a single `<image>` and shifted so that the frame
 * we want lands at the origin; a clip path the size of one frame hides the
 * rest. That way switching frames only moves the image, and the browser never
 * has to fetch or decode anything again.
 */
const Sprite = component((_: WeakKey, props: SpriteProps) => {
  const sprite = new SpriteStore(props);
  const clipId = `sprite_${randomId()}`;

  return $$("g", [
    // Start over whenever a different animation is selected. The `Derived` is
    // the cutoff: the key is a string, so two writes that leave it alone leave
    // the animation alone too.
    () => {
      const animationKey = new Derived(() => sprite.animationKey);
      useEffect(() => {
        animationKey.get();
        sprite.rewind();
      });
    },
    // Advance one frame per tick of the shared animation clock. Nothing is
    // chosen here and no value is read back — the clock is only held for as
    // long as the sprite stands — which is what `use` is for.
    effects(() => {
      use(each(clock, () => sprite.nextFrame()));
    }),
    attr("transform", () => {
      const geometry = sprite.geometry;
      return geometry ? `translate(${geometry.x},${geometry.y})` : undefined;
    }),
    attr("display", () => (sprite.geometry ? undefined : "none")),
    children(
      $$("defs", [
        children(
          $$("clipPath", [
            attr({ id: clipId, x: 0, y: 0 }),
            children(
              $$("rect", [
                attr({ x: 0, y: 0 }),
                attr("width", () => sprite.geometry?.spriteWidth ?? 0),
                attr("height", () => sprite.geometry?.spriteHeight ?? 0),
              ]),
            ),
          ]),
        ),
      ]),
      $$("image", [
        attr({ "clip-path": `url(#${clipId})` }),
        attr("href", () => sprite.geometry?.source),
        attr("transform", () => {
          const geometry = sprite.geometry;
          return geometry?.mirror ? `translate(${geometry.spriteWidth},0),scale(-1,1)` : undefined;
        }),
        attr("x", () => -(sprite.geometry?.frameOffsetX ?? 0)),
        attr("y", () => -(sprite.geometry?.frameOffsetY ?? 0)),
        attr("width", () => sprite.geometry?.imageWidth ?? 0),
        attr("height", () => sprite.geometry?.imageHeight ?? 0),
      ]),
    ),
  ]);
});

export default Sprite;
