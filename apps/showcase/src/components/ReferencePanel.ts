import * as THREE from "three";
import { $, RendererContext, htmlTextureMaterial } from "justdom-three";
import { children as domChildren, type Mountable } from "justdom-core";
import { effects, onCleanup, useEffects, type EntityEffect, type Source } from "justdom-signal";

/**
 * A panel the browser draws, for `?panels=texture`: the reference the
 * mirror is compared against. The same panel markup the mirror would read
 * is mounted in an element of its own inside the renderer's canvas, which
 * `layoutsubtree` lets the browser lay out and paint there and nowhere on
 * the page, and three's `HTMLTexture` uploads that paint (HTML-in-Canvas).
 * The plane is the card's size at the portal's scale, with its origin in the
 * card's middle, so it stands exactly where the mirror's object would.
 *
 * The browser draws everything CSS can, so what it shows is what the page
 * means; where the mirror differs from it, the mirror is wrong. Input is not
 * forwarded: the reference is for looking at.
 *
 * One `HTMLTexture` listens to the canvas's `paint` at a time, so the deck
 * shows one reference panel at a time.
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
      const canvas = RendererContext.get(ctx).domElement;
      const host = document.createElement("div");
      host.style.width = `${width}px`;
      host.style.height = `${height}px`;
      // What `locate` measures an element against, as it does a portal's
      // root.
      host.setAttribute("data-reference", "");
      useEffects(host, [domChildren(content)]);
      canvas.setAttribute("layoutsubtree", "");
      canvas.append(host);
      // HTML-in-Canvas's own call, which no lib.dom has yet.
      (canvas as { requestPaint?: () => void }).requestPaint?.();

      // The texture is made on the first paint, and not before: made
      // earlier, three uploads on every frame and throws until the paint
      // has come. Made from an element the canvas already holds, it marks
      // itself for upload on every paint after.
      let texture: THREE.HTMLTexture | null = null;
      const onPaint = (event: Event) => {
        // A paint that did not paint the panel leaves nothing to upload yet.
        const changed = (event as Event & { changedElements?: readonly Element[] }).changedElements;
        if (texture || (changed && !changed.includes(host))) {
          return;
        }
        texture = new THREE.HTMLTexture(host);
        texture.colorSpace = THREE.SRGBColorSpace;
        m.material.map = texture;
        m.material.needsUpdate = true;
        m.visible = true;
        onPainted();
      };
      canvas.addEventListener("paint", onPaint);

      onCleanup(() => {
        canvas.removeEventListener("paint", onPaint);
        texture?.dispose();
        host.remove();
        if (!canvas.firstElementChild) {
          canvas.removeAttribute("layoutsubtree");
        }
        m.geometry.dispose();
        m.material.dispose();
      });
    }),
    ...objectEffects,
  ]);
}
