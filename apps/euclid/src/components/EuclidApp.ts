import { $, children, className, set } from "justdom";
import type AppStore from "../store/App";
import Canvas, { type CanvasOptions } from "./Canvas";
import Editor from "./Editor";
import StatusBar from "./StatusBar";
import Toolbar from "./Toolbar";

const editorPaneStyle = className`
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  border-right: 1px solid #e0dbcd;
`;

const editorBodyStyle = className`
  flex: 1;
  min-height: 0;
`;

/**
 * The app, as three trees over one store: the toolbar, the program with its
 * status line, and the drawing. They are mounted in three places on the
 * page, which lays them out as one editor, because a headset session
 * mirrors each into a panel of its own, and a panel is the element it is
 * mounted in. `canvas` says how the drawing is drawn.
 */
const EuclidApp = (store: AppStore, canvas: CanvasOptions) => ({
  toolbar: Toolbar(store),
  editor: $("div", [
    set("className", editorPaneStyle),
    children(
      $("div", [set("className", editorBodyStyle), children(Editor(store))]),
      StatusBar(store),
    ),
  ]),
  canvas: Canvas(store, canvas),
});

export default EuclidApp;
