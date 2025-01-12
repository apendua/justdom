import { dependencies, observable } from "@apendua.dev/store4";
import { Observable } from "rxjs";
import { createProperty } from "@apendua.dev/context";

interface Dimensions {
  width: number;
  height: number;
}

class Root {
  @observable(function () {
    return new Observable<Dimensions>((subscriber) => {
      const listener = () => {
        subscriber.next({
          width: window.innerWidth,
          height: window.innerHeight,
        });
      };
      window.addEventListener("resize", listener);
      return () => {
        window.removeEventListener("resize", listener);
      };
    });
  })
  public get dimensions(): Dimensions {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  @dependencies("dimensions")
  public get screenWidth(): number {
    return this.dimensions.width;
  }

  @dependencies("dimensions")
  public get screenHeight(): number {
    return this.dimensions.height;
  }
}

export const RootContext = createProperty(() => new Root());

export default Root;
