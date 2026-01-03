import * as THREE from "three";
import { map, Observable } from "rxjs";
import { Derived, NoValueError, onInvalidate, Signal, Source } from "@apendua.dev/signal";
import { effects, flatten, just, set, use } from "@apendua.dev/reactive";
import { animate } from "../render.js";
import { $, children } from "../operators.js";
import { shareObservable } from "@apendua.dev/store4";
import { Font } from "three/examples/jsm/loaders/FontLoader.js";

/**
 * @param {string} fontFamily
 * @returns {string}
 */
function findFontUrl(fontFamily) {
  // Normalize the font family name (remove quotes, trim)
  const normalizedFamily = fontFamily.replace(/['"]/g, "").trim().toLowerCase();
  for (let i = 0; i < document.styleSheets.length; i++) {
    const styleSheet = document.styleSheets[i];
    try {
      for (let j = 0; j < styleSheet.cssRules.length; j++) {
        const rule = styleSheet.cssRules[j];
        if (rule instanceof CSSFontFaceRule) {
          const ruleFontFamily = rule.style
            .getPropertyValue("font-family")
            .replace(/['"]/g, "")
            .trim()
            .toLowerCase();

          if (ruleFontFamily === normalizedFamily) {
            const src = rule.style.getPropertyValue("src");
            // Extract URL from src (can be multiple formats)
            const urlMatch = src.match(/url\(['"]?([^'"]+)['"]?\)/);
            if (urlMatch) {
              return urlMatch[1];
            }
          }
        }
      }
    } catch (e) {
      console.warn("Could not access stylesheet:", e);
    }
  }
  throw new NoValueError();
}

const loadFont = shareObservable(
  /**
   * @param {string} path
   * @returns {Observable<Font>}
   */
  (path) => {
    return new Observable((subscriber) => {
      import("three/examples/jsm/loaders/TTFLoader.js")
        .then(({ TTFLoader }) => {
          const loader = new TTFLoader();
          loader.load(
            path,
            (font) => {
              subscriber.next(new Font(font));
            },
            () => {},
            (error) => {
              console.warn(error);
            },
          );
        })
        .catch((err) => {
          subscriber.error(err);
        });
    });
  },
);

const generateText = shareObservable(
  /**
   * @param {string} path
   * @param {string} text
   * @returns {Observable<THREE.BufferGeometry>}
   */
  (path, text) => {
    return loadFont(path).pipe(
      map((font) => {
        const shapes = font.generateShapes(text, font.data.resolution);
        const geometry = new THREE.ShapeGeometry(shapes);
        onInvalidate(() => {
          geometry.dispose();
        });
        return geometry;
      }),
    );
  },
);

/**
 * @param {WeakKey} ctx
 * @param {Text} textNode
 * @returns {Observable<THREE.Object3D>}
 */
export function text(ctx, textNode) {
  const object = new THREE.Object3D();
  /** @type {Signal<undefined | string>} */
  const textColor = new Signal(undefined);
  /** @type {Signal<string>} */
  const fontFamily = new Signal("");
  /** @type {Signal<number>} */
  const fontSize = new Signal(1);
  /** @type {Derived<Font>} */
  const font = new Derived(() => {
    const fontUrl = findFontUrl(fontFamily.get());
    return new Source(loadFont(fontUrl)).get();
  });
  /** @type {Signal<string>} */
  const textContent = new Signal(textNode.textContent);

  // const material = new Derived(() => {
  //   const basic = new THREE.MeshBasicMaterial();
  //   new Derived(() => {
  //     basic.color.set(backgroundColor.get());
  //   }).get();
  //   onInvalidate(() => {
  //     basic.dispose();
  //   });
  //   return basic;
  // });

  const textMaterial = shareObservable(() => {
    return just(
      new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
      }),
      [
        effects((material) => {
          material.color.set(textColor.get() ?? "black");
        }),
        effects((material) => {
          onInvalidate(() => {
            material.dispose();
          });
        }),
      ],
    );
  });

  const range = document.createRange();
  range.selectNodeContents(textNode);

  return just(object, [
    effects((obj) => {
      use(
        animate(ctx, () => {
          if (!textNode.parentElement) {
            return;
          }
          const style = getComputedStyle(textNode.parentElement);
          textColor.set(style.color);
          fontFamily.set(style.fontFamily);
          fontSize.set(parseFloat(style.fontSize));
          textContent.set(textNode.textContent);

          const textRect = range.getBoundingClientRect();
          const parentRect = textNode.parentElement?.getBoundingClientRect();
          if (parentRect) {
            const left = textRect.left - parentRect.left;
            const top = textRect.top - parentRect.top;
            obj.position.set(left, top, -0.01);
          } else {
            obj.position.set(textRect.left, textRect.top, -0.01);
          }
        }),
      );
    }),
    children(
      $(new THREE.Mesh(), [
        set("material", textMaterial()),
        set(
          "geometry",
          flatten(() => {
            const fontUrl = findFontUrl(fontFamily.get());
            return generateText(fontUrl, textContent.get() || "");
          }),
        ),
        effects((obj) => {
          const { data } = font.get();
          const scale = fontSize.get() / (data.ascender - data.underlinePosition);
          obj.position.set(0, fontSize.get(), 0.01);
          obj.scale.set(scale, -scale, scale);
        }),
      ]),
    ),
  ]);
}
