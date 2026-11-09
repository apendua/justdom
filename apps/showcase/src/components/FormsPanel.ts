import { className, stylesheet, text, $, attr, children, set, CLASS_NAME } from "justdom-core";
import { component } from "justdom-signal";
import { cardStyle, captionStyle, classes, fontFamily, headingStyle, rowStyle } from "./panels.js";

/**
 * Form controls: checkboxes, whose tick the scene draws in the element's
 * own `color`, styled by `:checked` and by the `data-xr-checked` flag the
 * portal writes back, the next sibling included; and text fields with a
 * value, with a placeholder and for a number, which open the scene's
 * keyboard when pressed. While the keyboard types into a field, the field
 * carries `data-xr-focus`, which a `:focus` rule answers.
 */

/** A ticked box's fill, which nothing else on the panel wears. */
const TICKED = "rgb(0, 123, 255)";

const checkStyle = className`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  cursor: pointer;
`;

/**
 * The box. `appearance: none` is implied in a scene and is what makes the
 * page agree with it; the tick is drawn in `color`.
 */
const boxStyle = stylesheet`
  .${CLASS_NAME} {
    appearance: none;
    margin: 0;
    width: 22px;
    height: 22px;
    border: 2px solid rgb(190, 196, 212);
    border-radius: 5px;
    background-color: rgb(255, 255, 255);
    color: rgb(255, 255, 255);
    cursor: pointer;
  }

  .${CLASS_NAME}:checked,
  .${CLASS_NAME}[data-xr-checked] {
    background-color: ${TICKED};
    border-color: ${TICKED};
  }
`;

const greenStyle = stylesheet`
  .${CLASS_NAME}:checked,
  .${CLASS_NAME}[data-xr-checked] {
    background-color: rgb(64, 148, 88);
    border-color: rgb(64, 148, 88);
  }
`;

/** A to-do whose label lights up while the box before it is ticked. */
const todoStyle = stylesheet`
  .${CLASS_NAME} {
    padding: 6px 10px;
    border-radius: 8px;
    background-color: rgb(228, 231, 240);
    font-size: 14px;
    cursor: pointer;
  }

  input:checked + .${CLASS_NAME},
  input[data-xr-checked] + .${CLASS_NAME} {
    background-color: ${TICKED};
    color: rgb(255, 255, 255);
  }
`;

const wideRowStyle = className`
  gap: 22px;
`;

const fieldRowStyle = className`
  align-items: flex-end;
  gap: 18px;
`;

const spacedStyle = className`
  margin-top: 10px;
`;

const fieldStyle = className`
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: rgb(110, 116, 136);
`;

const inputStyle = stylesheet`
  .${CLASS_NAME} {
    font-family: ${fontFamily};
    font-size: 15px;
    color: rgb(40, 44, 58);
    width: 240px;
    padding: 9px 12px;
    border: 2px solid rgb(214, 218, 230);
    border-radius: 10px;
    background-color: rgb(255, 255, 255);
    outline: none;
  }

  .${CLASS_NAME}::placeholder {
    color: rgb(150, 156, 172);
  }

  .${CLASS_NAME}:focus {
    border-color: ${TICKED};
    outline: 2px solid ${TICKED};
    outline-offset: 2px;
  }
`;

const numberStyle = className`
  width: 110px;
`;

const caption = (words: string) =>
  $("p", [set("className", captionStyle), children(text`${words}`)]);

/** A checkbox, with an id when a label elsewhere points at it. */
const box = (checked: boolean, id?: string, ...more: ReturnType<typeof className>[]) =>
  $("input", [
    set("className", more.length ? classes(boxStyle, ...more) : boxStyle),
    // The attribute is the box's starting state, as in markup; a ray's
    // click toggles the property from there.
    attr({ type: "checkbox", ...(id ? { id } : {}), ...(checked ? { checked: "" } : {}) }),
  ]);

const field = (
  label: string,
  input: Record<string, string>,
  ...more: ReturnType<typeof className>[]
) =>
  $("label", [
    set("className", fieldStyle),
    children(
      text`${label}`,
      $("input", [
        set("className", more.length ? classes(inputStyle, ...more) : inputStyle),
        attr(input),
      ]),
    ),
  ]);

const FormsPanel = component((_ctx: WeakKey) => {
  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", headingStyle), children(text`Forms`)]),
      caption("checkboxes, the tick in the element's color"),
      $("div", [
        set("className", classes(rowStyle, wideRowStyle)),
        children(
          $("label", [set("className", checkStyle), children(box(true), text`Ticked`)]),
          $("label", [set("className", checkStyle), children(box(false), text`Not ticked`)]),
          $("label", [
            set("className", checkStyle),
            children(box(true, undefined, greenStyle), text`Green`),
          ]),
        ),
      ]),
      caption(":checked and [data-xr-checked] styling the next sibling"),
      $("div", [
        set("className", rowStyle),
        children(
          box(true, "forms-milk"),
          $("label", [
            set("className", todoStyle),
            attr({ for: "forms-milk" }),
            children(text`Buy milk`),
          ]),
          box(false, "forms-dog"),
          $("label", [
            set("className", todoStyle),
            attr({ for: "forms-dog" }),
            children(text`Walk the dog`),
          ]),
        ),
      ]),
      caption("fields: a value, a placeholder, :focus while the keyboard types"),
      $("div", [
        set("className", classes(rowStyle, fieldRowStyle)),
        children(
          field("Name", { type: "text", value: "Ada Lovelace" }),
          field("Email", { type: "email", placeholder: "you@example.com", "data-field": "email" }),
        ),
      ]),
      $("div", [
        set("className", classes(rowStyle, spacedStyle)),
        children(field("Quantity, the number pad", { type: "number", value: "3" }, numberStyle)),
      ]),
    ),
  ]);
});

export default FormsPanel;
