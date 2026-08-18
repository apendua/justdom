import * as THREE from "three";
import { component, effects, set, emit, observable, on, Op, store } from "@apendua/signal";
import { dom } from "@apendua/freedom";
import type { AudioOutputSelection } from "@apendua.dev/sound";
import { diagnosticsButton, type DiagnosticsControls } from "@apendua.dev/diagnostics";
import { children, list, $, text } from "@apendua/justdom";
import {
  actionButton,
  actionButtonClass,
  debugValue,
  hintValue,
  panelCard,
  panelStack,
  panelTitle,
  victoryBanner,
} from "./styles.js";
import { ForkHand, Phase } from "../store/Session.js";
import { musicCard, MusicCardState } from "./MusicCard.js";

interface GameUIProps extends MusicCardState {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  phase: Phase;
  // While the castle is going up.
  bricks: number;
  canUndo: boolean;
  canRedo: boolean;
  // While it is coming down.
  standing: number;
  total: number;
  shots: number;
  won: boolean;
  forkHand: ForkHand;
  gazeAim: boolean;
}

interface GameUIEvents {
  ready: void;
  undo: void;
  redo: void;
  clear: void;
  rebuild: void;
  swapHands: void;
  toggleGazeAim: void;
  quieter: void;
  louder: void;
}

const defaults: GameUIProps = {
  position: new THREE.Vector3(),
  rotation: new THREE.Euler(),
  phase: "build",
  bricks: 0,
  canUndo: false,
  canRedo: false,
  standing: 0,
  total: 0,
  shots: 0,
  won: false,
  forkHand: "left",
  gazeAim: false,
  volume: 0,
};

/**
 * The one panel, through both phases of the game. It used to be two — one
 * panel for building and another for the siege, swapped wholesale when the
 * phase changed — but the swap threw away a perfectly good panel, portal,
 * music card and all, only to build the same thing again with different rows
 * in the middle. Now the stack, the cards and the projection stay put, and
 * pressing Ready merely trades one card's rows for the other's: the DOM
 * updates in place, and the mirror re-projects what changed rather than
 * everything.
 */
const GameUI = component(
  (
    ctx: WeakKey,
    /** Where the soundtrack goes, which the music card both shows and sets. */
    output: AudioOutputSelection,
    /** The frame rate panel, which the button under the music card switches. */
    diagnostics: DiagnosticsControls,
    operators: Op<GameUIProps, GameUIEvents>,
  ) => {
    const props = store<GameUIProps, GameUIEvents>(defaults, operators);
    const hasBricks = observable(() => props.bricks > 0);
    const building = () => props.phase === "build";

    /** What the main card offers while the castle is going up. */
    const buildActions = () =>
      $("div", [
        children(
          $("div", [set("className", debugValue), children(text`Bricks: ${() => props.bricks}`)]),
          $("div", [
            set("className", actionButtonClass(hasBricks)),
            on("click", () => {
              emit(props, "ready", undefined);
            }),
            children(text`Ready`),
          ]),
          $("div", [
            set("className", actionButtonClass(observable(() => props.canUndo))),
            on("click", () => {
              emit(props, "undo", undefined);
            }),
            children(text`Undo`),
          ]),
          $("div", [
            set("className", actionButtonClass(observable(() => props.canRedo))),
            on("click", () => {
              emit(props, "redo", undefined);
            }),
            children(text`Redo`),
          ]),
          $("div", [
            set("className", actionButtonClass(hasBricks)),
            on("click", () => {
              emit(props, "clear", undefined);
            }),
            children(text`Clear`),
          ]),
        ),
      ]);

    /** And what it offers while the castle is coming down. */
    const siegeActions = () =>
      $("div", [
        children(
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
      ]);

    const buildHelp = () =>
      $("div", [
        children(
          $("div", [set("className", debugValue), children(text`Trigger: grab and place`)]),
          $("div", [set("className", debugValue), children(text`Grip: pull out a copy`)]),
          $("div", [set("className", debugValue), children(text`Stick: turn the brick`)]),
          $("div", [set("className", debugValue), children(text`Off the board: remove`)]),
          $("div", [set("className", debugValue), children(text`A / B: undo, redo`)]),
        ),
      ]);

    const siegeHelp = () =>
      $("div", [
        children(
          $("div", [set("className", debugValue), children(text`Reach for the pouch`)]),
          $("div", [set("className", debugValue), children(text`Hold trigger, pull back`)]),
          $("div", [set("className", debugValue), children(text`Let go to shoot`)]),
          // The way to play at a desk, where there is no second hand to reach
          // with — and no first hand that is easy to aim.
          $("div", [set("className", hintValue), children(text`No hands? Hold Space`)]),
        ),
      ]);

    return dom(
      ctx,
      $("div", [
        set("className", panelStack),
        children(
          $("div", [
            set("className", panelCard),
            children(
              $("div", [
                set("className", panelTitle),
                children(text`${() => (building() ? "Build" : "Siege")}`),
              ]),
              component(() => (building() ? buildActions() : siegeActions()))(),
            ),
          ]),
          $("div", [
            set("className", panelCard),
            children(
              $("div", [
                set("className", panelTitle),
                children(text`${() => (building() ? "Controls" : "The Slingshot")}`),
              ]),
              component(() => (building() ? buildHelp() : siegeHelp()))(),
            ),
          ]),
          musicCard(
            props,
            {
              quieter: () => {
                emit(props, "quieter", undefined);
              },
              louder: () => {
                emit(props, "louder", undefined);
              },
            },
            output,
          ),
          // Its own card next to the music one, because the stack is made of
          // cards and a button on its own between two of them would look like
          // something that had fallen out of one.
          $("div", [
            set("className", panelCard),
            children(diagnosticsButton(diagnostics, actionButton)),
          ]),
        ),
      ]),
      [
        effects((obj) => {
          obj.position.copy(props.position);
          obj.rotation.copy(props.rotation);
        }),
      ],
    );
  },
);

export default GameUI;
