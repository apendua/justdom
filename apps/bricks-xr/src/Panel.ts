/**
 * The whole interface. It is ordinary DOM — the same elements and stylesheets a
 * web page would use — projected into the scene by `dom()`, and clicked by
 * pointing a controller at it. No 3D interface toolkit is involved.
 */
import { component, effects, emit, on, Op, set, store } from "@apendua.dev/signal";
import { dom } from "@apendua.dev/three";
import { children, stylesheet, CLASS_NAME, $, text } from "@apendua.dev/dom";
import { palette } from "./palette.js";

interface Props {
  bricks: number;
}

interface Events {
  reset: void;
}

const card = stylesheet`
  .${CLASS_NAME} {
    font-family: sans-serif;
    background: ${palette.panel};
    border: 4px solid ${palette.panelEdge};
    border-radius: 14px;
    padding: 10px;
    width: 300px;
    color: ${palette.panelText};
  }
`;

const line = stylesheet`
  .${CLASS_NAME} {
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 10px;
    padding: 8px 10px;
    margin-top: 6px;
  }
`;

const button = stylesheet`
  .${CLASS_NAME} {
    background: ${palette.button};
    border: 2px solid ${palette.buttonEdge};
    border-radius: 12px;
    text-align: center;
    padding: 12px;
    margin-top: 10px;
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
  }
`;

const Panel = component((ctx: WeakKey, operators: Op<Props, Events>) => {
  const props = store<Props, Events>({ bricks: 0 }, operators);
  return dom(
    ctx,
    $("div", [
      set("className", card),
      children(
        $("div", [set("className", line), children(text`Bricks placed: ${() => props.bricks}`)]),
        $("div", [set("className", line), children(text`Trigger: grab and place`)]),
        $("div", [set("className", line), children(text`Off the grid: remove`)]),
        $("div", [
          set("className", button),
          on("click", () => emit(props, "reset", undefined)),
          children(text`Reset`),
        ]),
      ),
    ]),
    [
      effects((o) => {
        // Off to the left of the board, turned towards the player.
        o.position.set(-9, 5, 2);
        o.rotation.set(0, Math.PI / 8, 0);
      }),
    ],
  );
});

export default Panel;
