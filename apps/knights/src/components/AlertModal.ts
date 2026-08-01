import {
  $,
  CLASS_NAME,
  attr,
  children,
  on,
  renderText,
  set,
  stylesheet,
  text,
} from "@apendua.dev/dom";
import { component } from "@apendua.dev/signal";
import { modal, modalFill } from "./styles";

interface AlertModalProps {
  isVisible: boolean;
  message: string;
  buttonText: string;
  onButtonClick?: () => void;
}

const backdrop = stylesheet`
  .${CLASS_NAME} {
    background: rgba(0, 0, 0, 0.4);
  }
`;

const alertBody = stylesheet`
  .${CLASS_NAME} {
    flex-grow: 0;
    width: 50vw;
    margin: auto;
    padding: 0 2vh 2vh 2vh;
    border-top: 2vh solid black;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    font-family: monospace;
    line-height: 5vh;
    font-size: 2vh;
  }
`;

const alertContent = stylesheet`
  .${CLASS_NAME} {
    text-align: center;
    line-height: 3vh;
    margin-bottom: 1vh;
  }
`;

const alertButton = stylesheet`
  .${CLASS_NAME} {
    cursor: pointer;
    background: black;
    border: 1px solid #444;
    color: white;
    text-align: center;
  }

  .${CLASS_NAME}:hover {
    background: #222;
  }
`;

/**
 * The notice asking whether the player's id may be stored.
 */
const AlertModal = component((_: WeakKey, props: AlertModalProps) => {
  return $("div", [
    set("className", renderText`${modal} ${backdrop}`),
    attr("hidden", () => (props.isVisible ? undefined : "")),
    children(
      $("div", [set("className", modalFill)]),
      $("div", [
        set("className", alertBody),
        children(
          $("div", [
            set("className", alertContent),
            children($("p", [children(text`${() => props.message}`)])),
          ]),
          $("div", [
            set("className", alertButton),
            on("click", () => props.onButtonClick?.()),
            children(text`${() => props.buttonText}`),
          ]),
        ),
      ]),
      $("div", [set("className", modalFill)]),
    ),
  ]);
});

export default AlertModal;
