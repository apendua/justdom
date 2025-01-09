import { $watch, dependencies, invalidate } from "@apendua.dev/store4";
import {
  getFieldBBox,
  getFieldSetBBox,
  getHexToPixelsMapping,
  getPixelsToHexMapping,
  to2D,
  VectorLike,
} from "@apendua.dev/geometry";
import { createProperty } from "@apendua.dev/context";

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

  @invalidate(function () {
    return $watch(this.#props).allFields;
  })
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

  @invalidate(function () {
    return $watch(this.#props).screenWidth;
  })
  get width() {
    return this.#props.screenWidth;
  }

  @invalidate(function () {
    return $watch(this.#props).screenHeight;
  })
  get height() {
    return this.#props.screenHeight;
  }

  @invalidate(function () {
    return $watch(this.#props).allFields;
  })
  get bounds() {
    return getFieldSetBBox(this.#props.allFields);
  }

  @dependencies("width", "origin", "bounds")
  get nColumns() {
    const baseWidth = getFieldBBox(this.origin).width;
    return this.bounds.width / baseWidth;
  }

  @dependencies("height", "origin", "bounds")
  get nRows() {
    const baseHeight = getFieldBBox(this.origin).height;
    return this.bounds.height / baseHeight;
  }

  @dependencies("width", "nColumns")
  get fieldWidth() {
    return Math.round(this.width / this.nColumns);
  }

  @dependencies("fieldWidth")
  get fieldHeight() {
    return this.fieldWidth;
  }

  @dependencies("fieldWidth", "nColumns", "width")
  get offsetX() {
    return this.width / 2 - (this.nColumns * this.fieldWidth) / 2;
  }

  @dependencies("fieldHeight", "nRows", "height")
  get offsetY() {
    return this.height / 2 - (this.nRows * this.fieldHeight) / 2;
  }

  @dependencies("fieldWidth", "fieldHeight", "offsetX", "offsetY", "origin")
  public get mapHexToPixels() {
    return getHexToPixelsMapping({
      origin: this.origin,
      fieldWidth: this.fieldWidth,
      fieldHeight: this.fieldHeight,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
    });
  }

  @dependencies("fieldWidth", "fieldHeight", "offsetX", "offsetY", "origin")
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

export const ViewportContext = createProperty(
  new Viewport({
    allFields: [{ x: 0, y: 0, z: 0 }],
    screenWidth: window.innerWidth,
    screenHeight: window.innerHeight,
  }),
);

export default Viewport;
