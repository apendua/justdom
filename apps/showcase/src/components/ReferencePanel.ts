import * as THREE from "three";
import {
  $,
  RendererContext,
  createElementTexture,
  drawInCanvas,
  htmlTextureMaterial,
  paintedElement,
} from "justdom-three";
import { children as domChildren, type Mountable } from "justdom-core";
import { effects, onCleanup, useEffects, type EntityEffect, type Source } from "justdom-signal";

/**
 * A panel the browser draws, for `?panels=texture`: the reference the
 * mirror is compared against. The same panel markup the mirror would read
 * is mounted in an element of its own, a drawable child of the renderer's
 * canvas that the browser lays out and paints there and nowhere on the page,
 * and each paint of it is uploaded to a texture (HTML-in-Canvas).
 * The plane is the card's size at the portal's scale, with its origin in the
 * card's middle, so it stands exactly where the mirror's object would.
 *
 * The browser draws everything CSS can, so what it shows is what the page
 * means; where the mirror differs from it, the mirror is wrong. Input is not
 * forwarded: the reference is for looking at.
 *
 */
export function referencePanel(
  ctx: WeakKey,
  content: Source<Mountable>,
  {
    width,
    height,
    scale,
    onPainted,
  }: {
    /** The card's size in px. */
    width: number;
    height: number;
    /** Group units per px, as the portal draws. */
    scale: number;
    /** Told once, when the browser has painted the panel for the first time. */
    onPainted: () => void;
  },
  objectEffects: EntityEffect<THREE.Object3D>[] = [],
) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width * scale, height * scale),
    htmlTextureMaterial(),
  );
  // Until the browser has painted the panel there is nothing to show.
  mesh.visible = false;
  return $(mesh, [
    effects((m) => {
      const renderer = RendererContext.get(ctx);
      const canvas = renderer.domElement;
      const host = document.createElement("div");
      host.style.width = `${width}px`;
      host.style.height = `${height}px`;
      // What `locate` measures an element against, as it does a portal's
      // root.
      host.setAttribute("data-reference", "");
      useEffects(host, [domChildren(content)]);
      const undraw = drawInCanvas(canvas, host);

      // Uploaded at each paint that painted the panel, and shown from the
      // first: before that there is no picture, and an upload throws.
      const { texture, upload, dispose } = createElementTexture(renderer, host);
      m.material.map = texture;
      const onPaint = (event: Event) => {
        if (!paintedElement(event, host)) {
          return;
        }
        upload();
        if (!m.visible) {
          m.visible = true;
          onPainted();
        }
      };
      canvas.addEventListener("paint", onPaint);

      onCleanup(() => {
        canvas.removeEventListener("paint", onPaint);
        dispose();
        host.remove();
        undraw();
        m.geometry.dispose();
        m.material.dispose();
      });
    }),
    ...objectEffects,
  ]);
}
