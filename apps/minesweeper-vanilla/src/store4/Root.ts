import { fromEvent } from "rxjs";
import { createProperty } from "@apendua.dev/context";
import { addDependency, Changes } from "@apendua.dev/signal";

interface Dimensions {
  width: number;
  height: number;
}

const resize = new Changes(fromEvent(window, "resize"));

class Root {
  public get dimensions(): Dimensions {
    addDependency(resize);
    return { width: window.innerWidth, height: window.innerHeight };
  }

  public get screenWidth(): number {
    return this.dimensions.width;
  }

  public get screenHeight(): number {
    return this.dimensions.height;
  }
}

export const RootContext = createProperty(() => new Root());

export default Root;
