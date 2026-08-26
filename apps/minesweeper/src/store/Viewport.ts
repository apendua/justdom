import {
  getFieldBBox,
  getFieldSetBBox,
  getHexToPixelsMapping,
  getPixelsToHexMapping,
  to2D,
  VectorLike,
} from "@apendua.dev/geometry";
import { createProperty, memo } from "@apendua/signal";

interface ViewportProps {
  allFields: VectorLike[];
  screenWidth: number;
  screenHeight: number;
}

class Viewport {
  #props: ViewportProps;

  constructor(props: ViewportProps) {
    this.#props = props;
  }

  @memo()
  public get origin(): VectorLike {
    let point: VectorLike | undefined;
    let row = Infinity;
    let column = Infinity;
    for (const f of this.#props.allFields) {
      const { x, y } = to2D(f);
      if (point === undefined || x + y < row + column) {
        point = { x: f.x, y: f.y, z: f.z };
        row = y;
        column = x;
      }
    }
    return point ?? { x: 0, y: 0, z: 0 };
  }

  get width() {
    return this.#props.screenWidth;
  }

  get height() {
    return this.#props.screenHeight;
  }

  @memo()
  get bounds() {
    return getFieldSetBBox(this.#props.allFields);
  }

  get nColumns() {
    const baseWidth = getFieldBBox(this.origin).width;
    return this.bounds.width / baseWidth;
  }

  get nRows() {
    const baseHeight = getFieldBBox(this.origin).height;
    return this.bounds.height / baseHeight;
  }

  get fieldWidth() {
    // Fields have a square bounding box, so the same size is used for both axes.
    // Scale by whichever axis is tighter so the board is never taller/wider than
    // the viewport (which would clip its top/bottom or left/right edges) — the
    // other axis just ends up with extra space around the board instead.
    return Math.round(Math.min(this.width / this.nColumns, this.height / this.nRows));
  }

  get fieldHeight() {
    return this.fieldWidth;
  }

  get offsetX() {
    return this.width / 2 - (this.nColumns * this.fieldWidth) / 2;
  }

  get offsetY() {
    return this.height / 2 - (this.nRows * this.fieldHeight) / 2;
  }

  public get mapHexToPixels() {
    return getHexToPixelsMapping({
      origin: this.origin,
      fieldWidth: this.fieldWidth,
      fieldHeight: this.fieldHeight,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
    });
  }

  public get mapPixelsToHex() {
    return getPixelsToHexMapping({
      origin: this.origin,
      fieldWidth: this.fieldWidth,
      fieldHeight: this.fieldHeight,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
    });
  }
}

export const ViewportContext = createProperty(() => {
  return new Viewport({
    allFields: [{ x: 0, y: 0, z: 0 }],
    screenWidth: window.innerWidth,
    screenHeight: window.innerHeight,
  });
});

export default Viewport;
