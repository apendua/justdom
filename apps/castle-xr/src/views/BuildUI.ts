import * as THREE from "three";
import { component, effects, set, emit, observable, on, Op, store } from "@apendua/signal";
import { dom } from "@apendua/freedom";
import type { AudioOutputSelection } from "@apendua.dev/sound";
import { diagnosticsButton, type DiagnosticsControls } from "@apendua.dev/diagnostics";
import { children, $, text } from "@apendua/justdom";
import {
  actionButton,
  actionButtonClass,
  debugValue,
  panelCard,
  panelStack,
  panelTitle,
} from "./styles.js";
import { musicCard, MusicCardState } from "./MusicCard.js";

interface BuildUIProps extends MusicCardState {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  bricks: number;
  canUndo: boolean;
  canRedo: boolean;
}

interface BuildUIEvents {
  ready: void;
  undo: void;
  redo: void;
  clear: void;
  quieter: void;
  louder: void;
}

const defaults: BuildUIProps = {
  position: new THREE.Vector3(),
  rotation: new THREE.Euler(),
  bricks: 0,
  canUndo: false,
  canRedo: false,
  volume: 0,
};

/** The panel while the castle is going up. */
const BuildUI = component(
  (
    ctx: WeakKey,
    /** Where the soundtrack goes, which the music card both shows and sets. */
    output: AudioOutputSelection,
    /** The frame rate panel, which the button under the music card switches. */
    diagnostics: DiagnosticsControls,
    operators: Op<BuildUIProps, BuildUIEvents>,
  ) => {
    const props = store<BuildUIProps, BuildUIEvents>(defaults, operators);
    const hasBricks = observable(() => props.bricks > 0);
    return dom(
      ctx,
      $("div", [
        set("className", panelStack),
        children(
          $("div", [
            set("className", panelCard),
            children(
              $("div", [set("className", panelTitle), children(text`Build`)]),
              $("div", [
                set("className", debugValue),
                children(text`Bricks: ${() => props.bricks}`),
              ]),
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
          ]),
          $("div", [
            set("className", panelCard),
            children(
              $("div", [set("className", panelTitle), children(text`Controls`)]),
              $("div", [set("className", debugValue), children(text`Trigger: grab and place`)]),
              $("div", [set("className", debugValue), children(text`Grip: pull out a copy`)]),
              $("div", [set("className", debugValue), children(text`Stick: turn the brick`)]),
              $("div", [set("className", debugValue), children(text`Off the board: remove`)]),
              $("div", [set("className", debugValue), children(text`A / B: undo, redo`)]),
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

export default BuildUI;
