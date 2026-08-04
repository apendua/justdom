import { $, $$, attr, children, className, keyedList, on } from "@apendua/justdom";
import { Signal, component, observable, set } from "@apendua/signal";
import { Circle, Line, Point } from "@apendua.dev/euclid-core";
import type { SceneItem } from "@apendua.dev/euclid-lang";
import { tap } from "rxjs";
import type AppStore from "../store/App";

const INK = "#1f1d1a";
const CONSTRUCTION = "#b3ac9d";
const HIGHLIGHT = "#2563eb";
const HOVER = "#60a5fa";
const LABEL = "#5b5648";
const PREVIEW = "#3b82f6";

const containerStyle = className`
  position: relative;
  height: 100%;
  overflow: hidden;
  background:
    radial-gradient(circle at 1px 1px, #e3ded1 1px, transparent 0) 0 0 / 24px 24px,
    #faf8f2;
  user-select: none;
  touch-action: none;
`;

const svgStyle = className`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
`;

interface DragState {
  mode: "maybe" | "pan" | "drag";
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** Set when the gesture would drag this free point. */
  pointName: string | null;
}

function realPoint(value: Point): { x: number; y: number } | null {
  if (!value.isFinite() || !value.isReal()) {
    return null;
  }
  const affine = value.affine();
  return { x: affine.x.re, y: affine.y.re };
}

const Canvas = component((store: AppStore) => {
  let svgRef: SVGSVGElement | undefined;
  let drag: DragState | null = null;
  const grabbing = Signal.of(false);

  const localPoint = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
    const rect = svgRef?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    };
  };

  const worldPoint = (e: PointerEvent) => {
    const { x, y } = localPoint(e);
    return store.toWorld(x, y);
  };

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) {
      return;
    }
    const screen = localPoint(e);
    const world = store.toWorld(screen.x, screen.y);
    const pointName =
      e.button === 0 && store.tool.get() === "select"
        ? store.draggablePointAt(world.x, world.y)
        : null;
    drag = {
      mode: "maybe",
      pointerId: e.pointerId,
      startX: screen.x,
      startY: screen.y,
      lastX: screen.x,
      lastY: screen.y,
      pointName,
    };
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent) => {
    const screen = localPoint(e);
    store.cursorWorld.set(store.toWorld(screen.x, screen.y));
    if (!drag || e.pointerId !== drag.pointerId) {
      updateHover(e);
      return;
    }
    if (drag.mode === "maybe") {
      const travel = Math.hypot(screen.x - drag.startX, screen.y - drag.startY);
      if (travel > 4) {
        if (drag.pointName) {
          drag.mode = "drag";
          store.beginDrag(drag.pointName);
        } else {
          drag.mode = "pan";
          grabbing.set(true);
        }
      }
    }
    if (drag.mode === "pan") {
      store.panBy(screen.x - drag.lastX, screen.y - drag.lastY);
    } else if (drag.mode === "drag" && drag.pointName) {
      const world = store.toWorld(screen.x, screen.y);
      store.dragTo(drag.pointName, world.x, world.y);
    }
    drag.lastX = screen.x;
    drag.lastY = screen.y;
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    const wasClick = drag.mode === "maybe";
    drag = null;
    grabbing.set(false);
    if (wasClick && e.button === 0) {
      const world = worldPoint(e);
      store.clickAt(world.x, world.y);
    }
  };

  const updateHover = (e: PointerEvent) => {
    const world = worldPoint(e);
    const item = store.findItemNear(world.x, world.y);
    store.hovered.set(item ? item.id : null);
  };

  const itemAt = (id: string): SceneItem | undefined => store.itemById.get().get(id);

  const strokeFor = (id: string): string => {
    if (store.highlightedIds.get().has(id)) {
      return HIGHLIGHT;
    }
    if (store.hovered.get() === id) {
      return HOVER;
    }
    const item = itemAt(id);
    return item?.drawn ? INK : CONSTRUCTION;
  };

  const widthFor = (id: string): string => {
    if (store.highlightedIds.get().has(id) || store.hovered.get() === id) {
      return "2.25";
    }
    return itemAt(id)?.drawn ? "1.6" : "1";
  };

  const dashFor = (id: string): string => {
    const item = itemAt(id);
    if (item && !item.drawn && !store.highlightedIds.get().has(id)) {
      return "5 4";
    }
    return "";
  };

  const lineEndpoint = (id: string, which: 0 | 1): { x: number; y: number } => {
    const item = itemAt(id);
    if (!item || !(item.value instanceof Line)) {
      return { x: 0, y: 0 };
    }
    const clipped = item.value.clipToRect(store.visibleRect());
    if (!clipped) {
      return { x: 0, y: 0 };
    }
    return store.toScreen(clipped[which].x, clipped[which].y);
  };

  const renderLine = (id: string) =>
    $$("line", [
      attr("stroke", () => strokeFor(id)),
      attr("stroke-width", () => widthFor(id)),
      attr("stroke-dasharray", () => dashFor(id)),
      attr("visibility", () => {
        const item = itemAt(id);
        return item && item.value instanceof Line && item.value.clipToRect(store.visibleRect())
          ? "visible"
          : "hidden";
      }),
      attr("x1", () => `${lineEndpoint(id, 0).x}`),
      attr("y1", () => `${lineEndpoint(id, 0).y}`),
      attr("x2", () => `${lineEndpoint(id, 1).x}`),
      attr("y2", () => `${lineEndpoint(id, 1).y}`),
    ]);

  const renderCircle = (id: string) =>
    $$("circle", [
      attr("fill", () => "none"),
      attr("stroke", () => strokeFor(id)),
      attr("stroke-width", () => widthFor(id)),
      attr("stroke-dasharray", () => dashFor(id)),
      attr("cx", () => {
        const item = itemAt(id);
        if (!item || !(item.value instanceof Circle)) {
          return "0";
        }
        const center = realPoint(item.value.center());
        return center ? `${store.toScreen(center.x, center.y).x}` : "0";
      }),
      attr("cy", () => {
        const item = itemAt(id);
        if (!item || !(item.value instanceof Circle)) {
          return "0";
        }
        const center = realPoint(item.value.center());
        return center ? `${store.toScreen(center.x, center.y).y}` : "0";
      }),
      attr("r", () => {
        const item = itemAt(id);
        if (!item || !(item.value instanceof Circle)) {
          return "0";
        }
        const radius = item.value.radius() * store.viewport.get().scale;
        return Number.isFinite(radius) ? `${Math.max(radius, 0)}` : "0";
      }),
    ]);

  const renderPolygon = (id: string) =>
    $$("path", [
      attr("fill", () => "rgba(31, 29, 26, 0.05)"),
      attr("stroke", () => strokeFor(id)),
      attr("stroke-width", () => widthFor(id)),
      attr("stroke-linejoin", () => "round"),
      attr("d", () => {
        const item = itemAt(id);
        if (!item || !Array.isArray(item.value)) {
          return "";
        }
        const parts = item.value
          .map((point) => realPoint(point))
          .filter((coords): coords is { x: number; y: number } => coords !== null)
          .map((coords, index) => {
            const screen = store.toScreen(coords.x, coords.y);
            return `${index === 0 ? "M" : "L"}${screen.x.toFixed(2)},${screen.y.toFixed(2)}`;
          });
        return parts.length > 1 ? `${parts.join(" ")} Z` : "";
      }),
    ]);

  const renderPoint = (id: string) => {
    const coords = () => {
      const item = itemAt(id);
      if (!item || !(item.value instanceof Point)) {
        return null;
      }
      return realPoint(item.value);
    };
    return $$("g", [
      attr("visibility", () => (coords() ? "visible" : "hidden")),
      children(
        $$("circle", [
          attr("r", () =>
            store.highlightedIds.get().has(id) || store.hovered.get() === id ? "5" : "3.6",
          ),
          attr("fill", () => {
            if (store.highlightedIds.get().has(id)) {
              return HIGHLIGHT;
            }
            if (store.hovered.get() === id) {
              return HOVER;
            }
            return itemAt(id)?.drawn ? INK : "#8d8878";
          }),
          attr("cx", () => {
            const c = coords();
            return c ? `${store.toScreen(c.x, c.y).x}` : "0";
          }),
          attr("cy", () => {
            const c = coords();
            return c ? `${store.toScreen(c.x, c.y).y}` : "0";
          }),
        ]),
        $$("text", [
          attr("x", () => {
            const c = coords();
            return c ? `${store.toScreen(c.x, c.y).x + 8}` : "0";
          }),
          attr("y", () => {
            const c = coords();
            return c ? `${store.toScreen(c.x, c.y).y - 8}` : "0";
          }),
          attr("fill", () => (store.highlightedIds.get().has(id) ? HIGHLIGHT : LABEL)),
          attr("font-style", () => "italic"),
          attr("font-family", () => "Georgia, 'Times New Roman', serif"),
          attr("font-size", () => "14"),
          set("textContent", () => itemAt(id)?.name ?? ""),
        ]),
      ),
    ]);
  };

  const renderItem = (kind: string, id: string) => {
    switch (kind) {
      case "line":
        return renderLine(id);
      case "circle":
        return renderCircle(id);
      case "polygon":
        return renderPolygon(id);
      default:
        return renderPoint(id);
    }
  };

  /** Curves first, points (with labels) on top. */
  const orderedItems = observable(() => {
    const items = store.scene.get().items;
    const curves = items.filter((item) => item.kind !== "point");
    const points = items.filter((item) => item.kind === "point");
    return [...curves, ...points].map(
      (item) => [`${item.kind}:${item.id}`, item] as [string, SceneItem],
    );
  });

  const axis = (isVertical: boolean) =>
    $$("line", [
      attr("stroke", () => "#e5e0d2"),
      attr("stroke-width", () => "1"),
      attr("x1", () => (isVertical ? `${store.toScreen(0, 0).x}` : "0")),
      attr("x2", () =>
        isVertical ? `${store.toScreen(0, 0).x}` : `${store.viewSize.get().width}`,
      ),
      attr("y1", () => (isVertical ? "0" : `${store.toScreen(0, 0).y}`)),
      attr("y2", () =>
        isVertical ? `${store.viewSize.get().height}` : `${store.toScreen(0, 0).y}`,
      ),
    ]);

  const pendingAnchor = (): { x: number; y: number } | null => {
    const pending = store.pending.get();
    if (!pending) {
      return null;
    }
    const definition = store.evaluation.get().definitions.get(pending.anchor);
    if (!definition || !(definition.value instanceof Point)) {
      return null;
    }
    return realPoint(definition.value);
  };

  // A dashed rubber-band preview of the line/circle being constructed.
  const previewLayer = () =>
    $$("g", [
      children(
        $$("line", [
          attr("stroke", () => PREVIEW),
          attr("stroke-width", () => "1.25"),
          attr("stroke-dasharray", () => "4 4"),
          attr("visibility", () => {
            const pending = store.pending.get();
            return pending?.tool === "line" && pendingAnchor() && store.cursorWorld.get()
              ? "visible"
              : "hidden";
          }),
          attr("x1", () => {
            const anchor = pendingAnchor();
            return anchor ? `${store.toScreen(anchor.x, anchor.y).x}` : "0";
          }),
          attr("y1", () => {
            const anchor = pendingAnchor();
            return anchor ? `${store.toScreen(anchor.x, anchor.y).y}` : "0";
          }),
          attr("x2", () => {
            const cursor = store.cursorWorld.get();
            return cursor ? `${store.toScreen(cursor.x, cursor.y).x}` : "0";
          }),
          attr("y2", () => {
            const cursor = store.cursorWorld.get();
            return cursor ? `${store.toScreen(cursor.x, cursor.y).y}` : "0";
          }),
        ]),
        $$("circle", [
          attr("fill", () => "none"),
          attr("stroke", () => PREVIEW),
          attr("stroke-width", () => "1.25"),
          attr("stroke-dasharray", () => "4 4"),
          attr("visibility", () => {
            const pending = store.pending.get();
            return pending?.tool === "circle" && pendingAnchor() && store.cursorWorld.get()
              ? "visible"
              : "hidden";
          }),
          attr("cx", () => {
            const anchor = pendingAnchor();
            return anchor ? `${store.toScreen(anchor.x, anchor.y).x}` : "0";
          }),
          attr("cy", () => {
            const anchor = pendingAnchor();
            return anchor ? `${store.toScreen(anchor.x, anchor.y).y}` : "0";
          }),
          attr("r", () => {
            const anchor = pendingAnchor();
            const cursor = store.cursorWorld.get();
            if (!anchor || !cursor) {
              return "0";
            }
            const radius =
              Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y) * store.viewport.get().scale;
            return `${radius}`;
          }),
        ]),
        // Snap indicator: where a click of the current tool would put a point.
        $$("circle", [
          attr("fill", () => "none"),
          attr("stroke", () => PREVIEW),
          attr("stroke-width", () => "1.5"),
          attr("visibility", () => (snapTarget() ? "visible" : "hidden")),
          attr("r", () => "7"),
          attr("cx", () => {
            const snap = snapTarget();
            return snap ? `${store.toScreen(snap.x, snap.y).x}` : "0";
          }),
          attr("cy", () => {
            const snap = snapTarget();
            return snap ? `${store.toScreen(snap.x, snap.y).y}` : "0";
          }),
        ]),
      ),
    ]);

  const snapTarget = (): { x: number; y: number } | null => {
    const tool = store.tool.get();
    const cursor = store.cursorWorld.get();
    if (!cursor || tool === "select") {
      return null;
    }
    const point = store.findPointNear(cursor.x, cursor.y);
    if (point) {
      return tool === "intersect" ? null : point;
    }
    const intersection = store.findIntersectionNear(cursor.x, cursor.y);
    return intersection ? { x: intersection.x, y: intersection.y } : null;
  };

  return $("div", [
    set("className", containerStyle),
    children(
      $$("svg", [
        attr("class", svgStyle),
        attr("cursor", () => {
          if (grabbing.get()) {
            return "grabbing";
          }
          return store.tool.get() === "select" ? "default" : "crosshair";
        }),
        on("pointerdown", handlePointerDown),
        on("pointermove", handlePointerMove),
        on("pointerup", handlePointerUp),
        on("pointercancel", () => {
          drag = null;
          grabbing.set(false);
        }),
        on("pointerleave", () => {
          store.cursorWorld.set(null);
          store.hovered.set(null);
        }),
        children(
          axis(false),
          axis(true),
          keyedList(orderedItems, (item) => renderItem(item.kind, item.id)),
          previewLayer(),
        ),
        tap((svg) => {
          if (svgRef !== svg) {
            svgRef = svg;
            svg.addEventListener(
              "wheel",
              (e: WheelEvent) => {
                e.preventDefault();
                const { x, y } = localPoint(e);
                store.zoomAt(x, y, Math.exp(-e.deltaY * 0.0015));
              },
              { passive: false },
            );
            const observer = new ResizeObserver((entries) => {
              for (const entry of entries) {
                store.viewSize.set({
                  width: entry.contentRect.width,
                  height: entry.contentRect.height,
                });
              }
            });
            observer.observe(svg);
          }
        }),
      ]),
    ),
  ]);
});

export default Canvas;
