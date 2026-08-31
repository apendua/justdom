import { addDependency, createProperty } from "@apendua/signal";
// RxJS's `fromEvent`, not the core's: the core's is typed for its own `Emitter`
// and a DOM `EventTarget` does not carry the event map it asks for. A window
// resize is an RxJS-native source, and it enters the graph as an ordinary
// subscribable.
import { fromEvent } from "rxjs";

interface Dimensions {
  width: number;
  height: number;
}

const resize = fromEvent(window, "resize");

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
