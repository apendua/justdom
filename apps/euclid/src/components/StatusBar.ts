import { $, children, className, set, style, text } from "justdom";
import { component } from "justdom-signal";
import type AppStore from "../store/App";

const statusStyle = className`
  padding: 6px 12px;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  border-top: 1px solid #e8e4d8;
  background: #f6f4ec;
  min-height: 18px;
  white-space: pre-wrap;
`;

function lineOfOffset(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i += 1) {
    if (code[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

const StatusBar = component((store: AppStore) => {
  const message = (): { text: string; isError: boolean } => {
    const code = store.code.get();
    const parseError = store.parsed.get().error;
    if (parseError) {
      return {
        text: `Parse error, line ${parseError.line}: ${parseError.message}`,
        isError: true,
      };
    }
    const runtimeError = store.evaluation.get().error;
    if (runtimeError) {
      return {
        text: `Error, line ${lineOfOffset(code, runtimeError.start)}: ${runtimeError.message}`,
        isError: true,
      };
    }
    const printed = store.evaluation.get().printed;
    if (printed.length > 0) {
      return { text: printed.map((entry) => entry.message).join("\n"), isError: false };
    }
    const count = store.scene.get().items.length;
    return {
      text: `${count} object${count === 1 ? "" : "s"}`,
      isError: false,
    };
  };

  return $("div", [
    set("className", statusStyle),
    style("color", () => (message().isError ? "#b91c1c" : "#7a7466")),
    children(text`${() => message().text}`),
  ]);
});

export default StatusBar;
