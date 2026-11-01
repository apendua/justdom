import * as THREE from "three";
import { xrSession } from "justdom-xr/session";
import {
  $,
  children,
  cursors,
  getScene,
  getXRSession,
  interactions,
  RendererContext,
  type XREventMap,
} from "justdom-three";
import { component, effects, effectsOnly, on, onCleanup, useEffects } from "justdom-signal";
import type { MountedDesk } from "../desk.js";
import type { Readable } from "../session.js";
import { disposedWithIt, lights, mug, NOTHING, pose, room } from "../components/Scene.js";
import { createPointerForwarder, type PointerForwarder } from "./forwarding.js";

type PanelMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial, XREventMap>;

/**
 * A flat panel showing one zone of the desk, cut from the texture the whole
 * desk is drawn into. Its plane is a unit square, scaled to the zone's size
 * by `fitToZone`, and its UVs are the zone's rect in the texture, so a ray's
 * hit reads straight off as a point of the desk.
 */
function panelMesh(): PanelMesh {
  const material = new THREE.MeshBasicMaterial({ transparent: true });
  // three uploads an `HTMLTexture` as RGBA8, which the GPU does not decode
  // from sRGB as it does an SRGB8_ALPHA8 one, so without this every colour
  // the page drew came out lighter. The map's shader decodes it inline when
  // this is defined, as it does for a video.
  material.defines = { DECODE_VIDEO_TEXTURE: "" };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material) as PanelMesh;
  // Until the desk has been painted once there is nothing to show.
  mesh.visible = false;
  return mesh;
}

/**
 * Size `mesh` to `zone` and point its UVs at the zone's rect in the
 * texture of `desk`, in the desk's own px. A portal draws a px a
 * centimetre, and `pose` scales the group for that, so the plane is a
 * hundredth of a metre per px. Rows of an `HTMLTexture` run from the
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
 * While a session runs the desk's element is a child of the renderer's
 * canvas, whose `layoutsubtree` lets the browser lay it out and draw it
 * there, and nowhere else, and three's `HTMLTexture` is made from it. Every time the
 * browser paints it anew the canvas fires `paint`, three uploads it again
 * with `texElementImage2D`, and the panels are fitted to where their zones
 * are now. When the session ends the element goes back where it was on the
 * page.
 *
 * A ray on a panel is a point of the desk, which `forwarding.ts` turns into
 * the events a mouse would have sent there, so the page's own handlers run
 * for a hand as they do for a mouse.
 */
export const TextureScene = (desk: Readable<MountedDesk>) =>
  effectsOnly((ctx: WeakKey) => {
    const { makeInteractive } = interactions(ctx);

    useEffects(getScene(ctx), [
      effects(() => {
        xrSession.set(getXRSession(ctx));
      }),
      children(
        ...lights(),
        component(() => {
          if (!getXRSession(ctx)) {
            return NOTHING;
          }
          const { look, root, elements } = desk.get();
          const canvas = RendererContext.get(ctx).domElement;
          const home = root.parentElement;
          canvas.setAttribute("layoutsubtree", "");
          canvas.append(root);
          canvas.requestPaint?.();

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

          // The texture is made on the first paint, and not before. Made
          // earlier, three moves the desk into the canvas itself on the
          // first frame and asks for a paint, and on every frame after it
          // uploads again, which throws until the paint has come ("No
          // cached paint record"): a session's frames do not wait for the
          // page's. Made from an element the canvas already holds, the
          // `HTMLTexture` sets the canvas's `onpaint` to mark it for upload
          // on every paint after, so here a paint only fits the panels.
          let texture: THREE.HTMLTexture | null = null;
          const meshes: PanelMesh[] = [];
          const fits: (() => void)[] = [];
          const onPaint = () => {
            if (!texture) {
              texture = new THREE.HTMLTexture(root);
              texture.colorSpace = THREE.SRGBColorSpace;
              // Rows from the element's top, as `fitToZone` counts them.
              // three flips a texture's rows on upload unless told not to,
              // and `texElementImage2D` honours it.
              texture.flipY = false;
              for (const mesh of meshes) {
                mesh.material.map = texture;
                mesh.material.needsUpdate = true;
                mesh.visible = true;
              }
            }
            fits.forEach((fit) => fit());
          };
          canvas.addEventListener("paint", onPaint);

          onCleanup(() => {
            canvas.removeEventListener("paint", onPaint);
            forwarders.forEach((forwarder) => forwarder.cancel());
            texture?.dispose();
            if (home && root.parentElement !== home) {
              home.append(root);
            }
            canvas.removeAttribute("layoutsubtree");
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
        })(),
        cursors(ctx, { color: "#ff5a3c" }),
      ),
    ]);
  });

export default TextureScene;
