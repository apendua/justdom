import { describe, expect, it } from "vitest";
import { renderHighlight } from "./Editor";

/** The text of every span carrying `style`, in order. */
function marked(html: string, style: string): string[] {
  const pre = document.createElement("pre");
  pre.innerHTML = html;
  return [...pre.querySelectorAll("span")]
    .filter((span) => span.getAttribute("style")?.includes(style))
    .map((span) => span.textContent ?? "");
}

describe("renderHighlight", () => {
  const code = "A=point(0, 0);\nB=point(4, 0);\nl=line(A, B);\n";

  it("grounds the selected statement, and nothing else", () => {
    const start = code.indexOf("B=");
    const end = code.indexOf(";", start) + 1;
    const html = renderHighlight(code, null, { start, end });
    expect(marked(html, "background").join("")).toBe("B=point(4, 0);");
  });

  it("grounds no line break, so no marked span runs across lines", () => {
    const start = code.indexOf("B=");
    const html = renderHighlight(code, null, { start, end: code.length });
    const spans = marked(html, "background");
    expect(spans.join("")).toBe("B=point(4, 0);l=line(A, B);");
    expect(spans.some((text) => text.includes("\n"))).toBe(false);
  });

  it("still underlines an error inside a selection", () => {
    const start = code.indexOf("4");
    const html = renderHighlight(code, { start, end: start + 1 }, { start: 0, end: code.length });
    expect(marked(html, "underline")).toEqual(["4"]);
  });

  it("keeps the text as it is", () => {
    const pre = document.createElement("pre");
    pre.innerHTML = renderHighlight(code, { start: 2, end: 7 }, { start: 15, end: 30 });
    expect(pre.textContent).toBe(`${code}\n`);
  });
});
