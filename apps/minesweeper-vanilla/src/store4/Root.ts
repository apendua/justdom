import { invalidate } from "@apendua.dev/store4";
import { Observable } from "rxjs";
import { createProperty } from "@apendua.dev/context";

interface Dimensions {
  width: number;
  height: number;
}

class Root {
  @invalidate(function () {
    return new Observable((subscriber) => {
      const listener = () => {
        subscriber.next({});
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

  public get screenWidth(): number {
    return this.dimensions.width;
  }

  public get screenHeight(): number {
    return this.dimensions.height;
  }
}

export const RootContext = createProperty(() => new Root());

export default Root;
