import { $, children, className, set } from "@apendua/justdom";
import { component } from "@apendua/signal";
import type AppStore from "../store/App";
import Canvas from "./Canvas";
import Editor from "./Editor";
import StatusBar from "./StatusBar";
import Toolbar from "./Toolbar";

const appStyle = className`
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
`;

const mainStyle = className`
  display: flex;
  flex: 1;
  min-height: 0;
`;

const editorPaneStyle = className`
  display: flex;
  flex-direction: column;
  width: 38%;
  min-width: 300px;
  max-width: 560px;
  border-right: 1px solid #e0dbcd;
  min-height: 0;
`;

const editorBodyStyle = className`
  flex: 1;
  min-height: 0;
`;

const canvasPaneStyle = className`
  flex: 1;
  min-width: 0;
`;

const EuclidApp = component((store: AppStore) => {
  return $("div", [
    set("className", appStyle),
    children(
      Toolbar(store),
      $("div", [
        set("className", mainStyle),
        children(
          $("div", [
            set("className", editorPaneStyle),
            children(
              $("div", [set("className", editorBodyStyle), children(Editor(store))]),
              StatusBar(store),
            ),
          ]),
          $("div", [set("className", canvasPaneStyle), children(Canvas(store))]),
        ),
      ]),
    ),
  ]);
});

export default EuclidApp;
