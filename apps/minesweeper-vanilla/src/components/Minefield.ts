import { list, $$, children, attr, on, className } from "@apendua.dev/dom";
import { Field, Fields, getKey } from "@apendua.dev/minesweeper";
import { observe } from "@apendua.dev/signal";
import { RootContext } from "../store4/Root";
import { ViewportContext } from "../store4/Viewport";
import { tap } from "rxjs";
import FieldSet from "./FieldSet";
import FieldStatus from "./FieldStatus";
import { component } from "@apendua.dev/signal";

const noSelect = className`
  position: absolute;
  top: 0;
  left: 0;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
`;

const COVERED_FILL = "#5c8a58";
const UNCOVERED_FILL = "#ede4d3";
const GRID_STROKE = "#2f3b2a";

// A touch held in place longer than this is a "flag" gesture instead of a tap.
const LONG_PRESS_MS = 450;
// A touch that drifts further than this before release is a scroll/drag, not a tap.
const MOVE_CANCEL_PX = 12;

const Minefield = component((ctx: WeakKey, game: Fields) => {
  const dimensions = RootContext.get(ctx);
  const viewport = ViewportContext.get(ctx);

  let svgRef: SVGSVGElement | undefined;

  const getFieldAt = (clientX: number, clientY: number): Field | undefined => {
    if (!svgRef) {
      return undefined;
    }
    const ctm = svgRef.getScreenCTM();
    if (!ctm) {
      return undefined;
    }
    const pt = svgRef.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const { hex } = viewport.mapPixelsToHex(pt.matrixTransform(ctm.inverse()));
    return hex ? game.getField(getKey(hex)) : undefined;
  };

  const handleOnClick = (e: MouseEvent) => {
    const field = getFieldAt(e.clientX, e.clientY);
    if (!field) {
      return;
    }
    if (e.shiftKey) {
      field.toggleFlag();
    } else {
      field.uncover();
    }
  };

  // Right-click is the mouse equivalent of a long press: flag without uncovering.
  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    getFieldAt(e.clientX, e.clientY)?.toggleFlag();
  };

  // Touch devices have no shift-click, so a long press on a field flags it instead of
  // uncovering it; a short tap uncovers as usual.
  let longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let touchOrigin: { x: number; y: number } | undefined;
  let longPressFlagged = false;

  const cancelLongPress = () => {
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }
  };

  const handleTouchStart = (e: TouchEvent) => {
    cancelLongPress();
    longPressFlagged = false;
    if (e.touches.length !== 1) {
      touchOrigin = undefined;
      return;
    }
    const { clientX, clientY } = e.touches[0];
    touchOrigin = { x: clientX, y: clientY };
    longPressTimer = setTimeout(() => {
      longPressTimer = undefined;
      longPressFlagged = true;
      getFieldAt(clientX, clientY)?.toggleFlag();
      if (typeof navigator.vibrate === "function") {
        navigator.vibrate(15);
      }
    }, LONG_PRESS_MS);
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (!touchOrigin || e.touches.length !== 1) {
      return;
    }
    const { clientX, clientY } = e.touches[0];
    const distance = Math.hypot(clientX - touchOrigin.x, clientY - touchOrigin.y);
    if (distance > MOVE_CANCEL_PX) {
      cancelLongPress();
    }
  };

  const handleTouchEnd = (e: TouchEvent) => {
    cancelLongPress();
    // Stops the browser from following up with a synthetic "click" for this touch.
    e.preventDefault();
    const origin = touchOrigin;
    const flagged = longPressFlagged;
    touchOrigin = undefined;
    longPressFlagged = false;
    if (flagged || !origin) {
      return;
    }
    const touch = e.changedTouches[0];
    if (!touch) {
      return;
    }
    const distance = Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y);
    if (distance <= MOVE_CANCEL_PX) {
      getFieldAt(touch.clientX, touch.clientY)?.uncover();
    }
  };

  const handleTouchCancel = () => {
    cancelLongPress();
    touchOrigin = undefined;
    longPressFlagged = false;
  };

  return $$("svg", [
    attr("class", noSelect),
    attr("width", () => dimensions.screenWidth.toString()),
    attr("height", () => dimensions.screenHeight.toString()),
    attr("viewbox", () => `0 0 ${dimensions.screenWidth} ${dimensions.screenHeight}`),
    on("click", handleOnClick),
    on("contextmenu", handleContextMenu),
    on("touchstart", handleTouchStart),
    on("touchmove", handleTouchMove),
    on("touchend", handleTouchEnd),
    on("touchcancel", handleTouchCancel),
    children(
      FieldSet(ctx, {
        get fields() {
          return game.coveredFields;
        },
        fill: COVERED_FILL,
        opacity: 1,
        get cursor() {
          return game.isGameOver ? "default" : "pointer";
        },
        borderWidth: 2,
      }),
      FieldSet(ctx, {
        get fields() {
          return game.uncoveredFields;
        },
        fill: UNCOVERED_FILL,
        opacity: 1,
        cursor: "default",
        borderWidth: 2,
      }),
      FieldSet(ctx, {
        get fields() {
          return game.allFields;
        },
        fill: GRID_STROKE,
        opacity: 0.85,
        cursor: "default",
        borderWidth: 2,
        cutHoles: true,
      }),
      list(observe(game).allFields, (field) => FieldStatus(ctx, field)),
    ),
    tap((svg) => {
      svgRef = svg;
    }),
  ]);
});

export default Minefield;
