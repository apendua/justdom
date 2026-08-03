import * as THREE from "three";
import { component, effects, set, emit, on, Op, store } from "@apendua.dev/signal";
import { dom } from "@apendua.dev/three";
import { children, list, $, text } from "@apendua.dev/dom";
import {
  actionButton,
  debugValue,
  hintValue,
  panelCard,
  panelStack,
  panelTitle,
  victoryBanner,
} from "./styles.js";
import { PointersContext } from "../elements/context.js";
import { ForkHand } from "../store/Session.js";

interface SiegeUIProps {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  standing: number;
  total: number;
  shots: number;
  won: boolean;
  forkHand: ForkHand;
  gazeAim: boolean;
}

interface SiegeUIEvents {
  rebuild: void;
  swapHands: void;
  toggleGazeAim: void;
}

const defaults: SiegeUIProps = {
  position: new THREE.Vector3(),
  rotation: new THREE.Euler(),
  standing: 0,
  total: 0,
  shots: 0,
  won: false,
  forkHand: "left",
  gazeAim: false,
};

/** The panel while the castle is being knocked down. */
const SiegeUI = component((ctx: WeakKey, operators: Op<SiegeUIProps, SiegeUIEvents>) => {
  const props = store<SiegeUIProps, SiegeUIEvents>(defaults, operators);
  return dom(
    ctx,
    $("div", [
      set("className", panelStack),
      children(
        $("div", [
          set("className", panelCard),
          children(
            $("div", [set("className", panelTitle), children(text`Siege`)]),
            // The banner only exists once there is something to celebrate.
            list(
              () => (props.won ? ["won"] : []),
              () =>
                $("div", [
                  set("className", victoryBanner),
                  children(text`Castle down in ${() => props.shots} shots`),
                ]),
            ),
            $("div", [
              set("className", debugValue),
              children(text`Standing: ${() => props.standing} / ${() => props.total}`),
            ]),
            $("div", [set("className", debugValue), children(text`Shots: ${() => props.shots}`)]),
            $("div", [
              set("className", actionButton),
              on("click", () => {
                emit(props, "swapHands", undefined);
              }),
              children(text`Fork Hand: ${() => props.forkHand}`),
            ]),
            $("div", [
              set("className", actionButton),
              on("click", () => {
                emit(props, "toggleGazeAim", undefined);
              }),
              children(text`Aim: ${() => (props.gazeAim ? "where you look" : "your hand")}`),
            ]),
            $("div", [
              set("className", actionButton),
              on("click", () => {
                emit(props, "rebuild", undefined);
              }),
              children(text`Back To Building`),
            ]),
          ),
        ]),
        $("div", [
          set("className", panelCard),
          children(
            $("div", [set("className", panelTitle), children(text`The Slingshot`)]),
            $("div", [set("className", debugValue), children(text`Reach for the pouch`)]),
            $("div", [set("className", debugValue), children(text`Hold trigger, pull back`)]),
            $("div", [set("className", debugValue), children(text`Let go to shoot`)]),
            // The way to play at a desk, where there is no second hand to reach
            // with — and no first hand that is easy to aim.
            $("div", [set("className", hintValue), children(text`No hands? Hold Space`)]),
          ),
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

export default SiegeUI;
