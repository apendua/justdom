/**
 * The whole interface: how many bricks are down, and a way back to an empty
 * board. It is ordinary DOM — the same elements a web page would use, with the
 * same stylesheets — projected into the scene by `dom()`, and clicked by
 * pointing a controller at it.
 */
import * as THREE from "three";
import { component, effects, emit, on, Op, set, store } from "@apendua.dev/signal";
import { dom } from "@apendua.dev/three";
import { children, $, text } from "@apendua.dev/dom";
import { actionButton, panelCard, panelTitle, panelValue } from "./styles.js";
import { PointersContext } from "../elements/context.js";

interface PanelProps {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  bricks: number;
}

interface PanelEvents {
  reset: void;
}

const defaults: PanelProps = {
  position: new THREE.Vector3(),
  rotation: new THREE.Euler(),
  bricks: 0,
};

const Panel = component((ctx: WeakKey, operators: Op<PanelProps, PanelEvents>) => {
  const props = store<PanelProps, PanelEvents>(defaults, operators);
  return dom(
    ctx,
    $("div", [
      set("className", panelCard),
      children(
        $("div", [set("className", panelTitle), children(text`Bricks`)]),
        $("div", [set("className", panelValue), children(text`Placed: ${() => props.bricks}`)]),
        $("div", [set("className", panelValue), children(text`Trigger: grab and place`)]),
        $("div", [set("className", panelValue), children(text`Off the grid: remove`)]),
        $("div", [
          set("className", actionButton),
          on("click", () => {
            emit(props, "reset", undefined);
          }),
          children(text`Reset`),
        ]),
      ),
    ]),
    [
      effects((obj) => {
        obj.position.copy(props.position);
        obj.rotation.copy(props.rotation);
      }),
      PointersContext.get(ctx),
    ],
  );
});

export default Panel;
