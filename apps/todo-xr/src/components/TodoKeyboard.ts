import { className, $, children, stylesheet, CLASS_NAME } from "justdom";
import { set, component } from "justdom-signal";
import { keyboard, KeyboardProps } from "justdom-three-ui";
import { fontFamily } from "./TodoApp.js";

/**
 * The board's own surface. This used to be a layer of the panel's DOM —
 * absolutely positioned below it and reclined with a CSS transform — and is
 * now the root of a portal of its own, so the position and the recline belong
 * to the scene (see `Scene.ts`) and the style keeps only what the board looks
 * like. The width is the panel's 464px minus the 0.5rem inset the layer
 * always kept on each side, so it spans the panel edge to edge exactly as
 * before — which, at ten columns to the phone-style row, makes each key about
 * 4 cm across in the scene: bigger than a real key, which a target at the
 * end of a ray wants to be.
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

interface TodoKeyboardProps {
  onKey: KeyboardProps["onKey"];
}

/**
 * The input keyboard, as a portal of its own.
 *
 * A portal is the unit a panel comes and goes as — its own surface, its own
 * batches, its own place in the scene — and the board is a panel in every
 * sense that matters: ninety keys are a bigger mount than the rest of the
 * app put together, and as a layer of the todo panel's DOM they were the
 * todo panel's problem, re-measured with it and moved with it. Being its
 * own portal is also what will let the board mount on the portal's terms
 * rather than the panel's: the keyboard's portal is created the first time
 * the board opens (see `Scene.ts`), so that first mount is its portal's
 * *initial* content — the moment a portal that knows how to defer its
 * mounting can hide until everything is built.
 */
const TodoKeyboard = component(({ onKey }: TodoKeyboardProps) => {
  return $("div", [
    set("className", boardSurfaceStyle),
    children(keyboard({ classes: keyboardClasses, onKey })),
  ]);
});

export default TodoKeyboard;
