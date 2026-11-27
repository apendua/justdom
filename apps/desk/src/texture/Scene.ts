import * as THREE from "three";
import { enterSession } from "justdom-xr/session";
import { whilePresenting } from "justdom-xr/scene";
import {
  $,
  children,
  createElementTexture,
  cursors,
  drawInCanvas,
  followUserActions,
  getScene,
  getXRSession,
  htmlTextureMaterial,
  interactions,
  paintedElement,
  RendererContext,
  type XREventMap,
} from "justdom-three";
import { component, effects, effectsOnly, on, onCleanup, useEffects } from "justdom-signal";
import type { MountedDesk } from "../desk.js";
import type { Readable } from "../session.js";
import { disposedWithIt, lights, mug, pose, room } from "../components/Scene.js";
import { createPointerForwarder, type PointerForwarder } from "./forwarding.js";
import { paintDiagnostics, type PaintCounts } from "./diagnostics.js";

type PanelMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial, XREventMap>;

/**
 * A flat panel showing one zone of the desk, cut from the texture the whole
 * desk is drawn into. Its plane is a unit square, scaled to the zone's size
 * by `fitToZone`, and its UVs are the zone's rect in the texture, so a ray's
 * hit reads straight off as a point of the desk.
 */
function panelMesh(): PanelMesh {
  return new THREE.Mesh(new THREE.PlaneGeometry(1, 1), htmlTextureMaterial()) as PanelMesh;
}

/**
 * Size `mesh` to `zone` and point its UVs at the zone's rect in the
 * texture of `desk`, in the desk's own px. A portal draws a px a
 * centimetre, and `pose` scales the group for that, so the plane is a
 * hundredth of a metre per px. Rows of the desk's texture run from the
 * element's top, so `t` grows downwards, the other way to the plane's `v`.
 * Written only when the zone has moved or changed size since the last fit.
 */
function fitToZone(mesh: PanelMesh, zone: HTMLElement, desk: HTMLElement): void {
  const width = desk.offsetWidth || 1;
  const height = desk.offsetHeight || 1;
  const w = zone.offsetWidth;
  const h = zone.offsetHeight;
  mesh.scale.set(w * 0.01, h * 0.01, 1);
  const u0 = zone.offsetLeft / width;
  const t0 = zone.offsetTop / height;
  const du = w / width;
  const dt = h / height;
  const uv = mesh.geometry.attributes.uv;
  // The plane's corners, in its own order: top left, top right, bottom
  // left, bottom right.
  const corners = [
    [0, 1],
    [1, 1],
    [0, 0],
    [1, 0],
  ];
  let changed = false;
  corners.forEach(([a, b], i) => {
    const u = u0 + a * du;
    const t = t0 + (1 - b) * dt;
    if (uv.getX(i) !== u || uv.getY(i) !== t) {
      uv.setXY(i, u, t);
      changed = true;
    }
  });
  if (changed) {
    uv.needsUpdate = true;
  }
}

/**
 * The scene of the desk's HTML-in-Canvas variant (`?panels=texture`): the
 * same room as `components/Scene.ts`, with each zone the look places drawn
 * from a texture rather than mirrored object by object.
 *
 * While a session runs the desk's element is a drawable child of the
 * renderer's canvas (`drawInCanvas`), which the browser lays out and draws
 * there, and nowhere else. Every time the browser paints it anew the canvas
 * fires `paint` listing it, its picture is uploaded again with
 * `texElementSubImage2D` (`createElementTexture`), and the panels are fitted
 * to where their zones are now. When the session ends the element goes back
 * where it was on the page.
 *
 * A ray on a panel is a point of the desk, which `forwarding.ts` turns into
 * the events a mouse would have sent there, so the page's own handlers run
 * for a hand as they do for a mouse.
 *
 * `?diag` adds a readout to the room of the session's features and the
 * canvas's paints, and `?diag&repaint` also asks for a paint every frame
 * (`diagnostics.ts`).
 */
export const TextureScene = (desk: Readable<MountedDesk>) =>
  effectsOnly((ctx: WeakKey) => {
    const { makeInteractive } = interactions(ctx);

    useEffects(getScene(ctx), [
      effects(() => {
        enterSession(getXRSession(ctx));
      }),
      children(
        ...lights(),
        // A `component`, so that the room is built again if the desk changes
        // its look during a session.
        whilePresenting(
          ctx,
          component(() => {
            const { look, root, elements } = desk.get();
            const renderer = RendererContext.get(ctx);
            const query = new URLSearchParams(location.search);
            const canvas = renderer.domElement;
            const home = root.parentElement;
            const undraw = drawInCanvas(canvas, root);
            // The looks write `:hover` and `:active` alone, which a panel's
            // portal rewrites to answer the flags the forwarder sets. Nothing
            // here mirrors the desk, so the session asks for the rewrite.
            const stopFollowing = followUserActions();

            // A pointer for each hand, the first to point the primary one.
            const forwarders = new Map<object, PointerForwarder>();
            const forwarderOf = (controller: object) => {
              let forwarder = forwarders.get(controller);
              if (!forwarder) {
                forwarder = createPointerForwarder({
                  pointerId: forwarders.size + 1,
                  isPrimary: forwarders.size === 0,
                });
                forwarders.set(controller, forwarder);
              }
              return forwarder;
            };

            // The desk is uploaded at each paint that painted it, and the
            // panels are shown from the first: before that there is no
            // picture, and an upload throws. A session's frames do not wait
            // for the page's paints, so until then they draw the room alone.
            const { texture, upload, dispose } = createElementTexture(renderer, root);
            // Rows from the element's top, as `fitToZone` counts them.
            texture.flipY = false;
            let painted = false;
            const counts: PaintCounts = { paints: 0, deskPaints: 0 };
            const meshes: PanelMesh[] = [];
            const fits: (() => void)[] = [];
            const onPaint = (event: Event) => {
              counts.paints += 1;
              if (!paintedElement(event, root)) {
                return;
              }
              counts.deskPaints += 1;
              upload();
              if (!painted) {
                painted = true;
                meshes.forEach((mesh) => (mesh.visible = true));
              }
              fits.forEach((fit) => fit());
            };
            canvas.addEventListener("paint", onPaint);

            onCleanup(() => {
              canvas.removeEventListener("paint", onPaint);
              forwarders.forEach((forwarder) => forwarder.cancel());
              dispose();
              if (home && root.parentElement !== home) {
                home.append(root);
              }
              undraw();
              stopFollowing();
            });

            const panel = (zone: HTMLElement) => {
              const mesh = panelMesh();
              const pointAt = (intersection: THREE.Intersection | undefined) => {
                const uv = intersection?.uv;
                if (!uv) {
                  return null;
                }
                const rect = root.getBoundingClientRect();
                return {
                  panel: zone,
                  clientX: rect.left + uv.x * rect.width,
                  clientY: rect.top + uv.y * rect.height,
                };
              };
              return $(mesh, [
                makeInteractive(),
                effects((m) => {
                  const fit = () => fitToZone(m, zone, root);
                  fit();
                  fits.push(fit);
                  meshes.push(m);
                  m.material.map = texture;
                  // Until the desk has been painted once there is nothing
                  // to show.
                  m.visible = painted;
                  onCleanup(() => {
                    fits.splice(fits.indexOf(fit), 1);
                    meshes.splice(meshes.indexOf(m), 1);
                    m.geometry.dispose();
                    m.material.dispose();
                  });
                }),
                on("pointerenter", (e) => forwarderOf(e.controller).move(pointAt(e.intersection))),
                on("pointermove", (e) => forwarderOf(e.controller).move(pointAt(e.intersection))),
                on("pointerleave", (e) => {
                  if (e.lost) {
                    forwarderOf(e.controller).cancel();
                  } else {
                    forwarderOf(e.controller).move(null);
                  }
                }),
                on("selectstart", (e) => forwarderOf(e.controller).press()),
                on("selectend", (e) => {
                  if (e.lost) {
                    forwarderOf(e.controller).cancel();
                  } else {
                    forwarderOf(e.controller).release();
                  }
                }),
              ]);
            };

            return $(new THREE.Group(), [
              effects(() => {
                getScene(ctx).background = new THREE.Color(look.room.backdrop);
              }),
              children(
                $(room(look.room), [disposedWithIt]),
                ...(query.has("diag")
                  ? [
                      $(
                        paintDiagnostics(
                          canvas,
                          renderer.xr.getSession(),
                          counts,
                          query.has("repaint"),
                        ),
                        [],
                      ),
                    ]
                  : []),
                ...(look.mug ? [$(mug(), [disposedWithIt])] : []),
                ...look.placements.flatMap((placement) => {
                  const zone = elements.get(placement.id);
                  if (!zone) {
                    return [];
                  }
                  return [
                    $(new THREE.Group(), [
                      effects((group) => pose(group, placement)),
                      children(panel(zone)),
                    ]),
                  ];
                }),
              ),
            ]);
          }),
        ),
        cursors(ctx, { color: "#ff5a3c" }),
      ),
    ]);
  });

export default TextureScene;
