import { className, $, children, stylesheet, CLASS_NAME } from "@apendua/justdom";
import { set, component } from "@apendua/signal";
import { keyboard } from "@apendua/justui";
import type { KeyboardTarget } from "@apendua/freedom";
import { fontFamily } from "./TodoApp.js";

/**
 * The board's own surface. The width is the panel's 464px minus the 0.5rem
 * inset the board keeps on each side, so it spans the panel edge to edge —
 * which, at ten columns to the phone-style row, makes each key about 4 cm
 * across in the scene: bigger than a real key, which a target at the end
 * of a ray wants to be.
 */
const boardSurfaceStyle = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    width: 448px;
    padding: 0.5rem;
    font-family: ${fontFamily};
    background-color: #2b2b2b;
    border-radius: 0.8rem;
  }
`;

const boardStyle = className`
  gap: 0.25rem;
`;

const rowStyle = className`
  gap: 0.25rem;
`;

const keyStyle = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    padding: 0.55rem 0;
    font-size: 0.9rem;
    /* "enter" is five characters; without these a label that outgrows its key
       spills onto its neighbours instead of being clipped by its own box. */
    white-space: nowrap;
    overflow: hidden;
    color: #f0f0f0;
    background-color: #3d3d3d;
    border-radius: 0.3rem;
    cursor: pointer;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background-color: #4f4f4f;
  }
`;

// Same specificity as the hover rule and later in the document, so a held
// shift stays lit while the ray is resting on it.
const keyHeldStyle = stylesheet`
  .${CLASS_NAME}, .${CLASS_NAME}[data-xr-hover] {
    background-color: #007bff;
  }
`;

const keyboardClasses = {
  root: boardStyle,
  row: rowStyle,
  key: keyStyle,
  keyActive: keyHeldStyle,
};

/**
 * The keyboard the scene offers the todo field: justui's board, dressed for
 * this panel, typing through whatever the portal hands it.
 *
 * This is the whole of what the app has to say about typing in a headset.
 * When the board appears, where it hangs, what a key does to the field and
 * when the board goes are the portal's — the same for every panel that
 * gives it a `keyboard` — so what is left to the app is the look, which is
 * exactly what the page's own keyboard, had it one, would leave to it.
 */
const TodoKeyboard = component(({ onKey, field }: Pick<KeyboardTarget, "onKey" | "field">) => {
  return $("div", [
    set("className", boardSurfaceStyle),
    // `field` is what lets the board follow the field it types into: a
    // number field would get the number pad.
    children(keyboard({ classes: keyboardClasses, onKey, field })),
  ]);
});

export default TodoKeyboard;
