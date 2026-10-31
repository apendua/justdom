import { afterEach, describe, expect, it } from "vitest";
import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
import { xrSession } from "@apendua.dev/headset/session";
import AppStore from "../store/App";
import Editor, { renderHighlightLines } from "./Editor";

/** The text of every span carrying `style`, in order. */
function marked(html: string, style: string): string[] {
  const pre = document.createElement("pre");
  pre.innerHTML = html;
  return [...pre.querySelectorAll("span")]
    .filter((span) => span.getAttribute("style")?.includes(style))
    .map((span) => span.textContent ?? "");
}

/** The rendered lines as one HTML string, as the panel shows them. */
function renderHighlight(...args: Parameters<typeof renderHighlightLines>): string {
  return renderHighlightLines(...args).join("\n");
}

describe("renderHighlightLines", () => {
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
    expect(pre.textContent).toBe(code);
  });
});

describe("the program's textarea", () => {
  afterEach(() => {
    xrSession.set(null);
    document.body.replaceChildren();
  });

  /** The editor, mounted as the page mounts it, and its textarea. */
  function mount() {
    const store = new AppStore();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const subscription = just(host, [children(Editor(store))]).subscribe({});
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    return { store, textarea, subscription };
  }

  /** What a press on a point of the drawing asks of the editor. */
  function selectFirstPoint(store: AppStore) {
    const item = store.scene.get().items[0];
    store.select(item);
  }

  it("takes the focus on a page, so the selected statement can be edited", () => {
    const { store, textarea, subscription } = mount();
    selectFirstPoint(store);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.readOnly).toBe(false);
    subscription.unsubscribe();
  });

  it("leaves the keyboard alone in a session, where a press selects a point", () => {
    const { store, textarea, subscription } = mount();
    xrSession.set({} as XRSession);
    selectFirstPoint(store);
    expect(document.activeElement).not.toBe(textarea);
    expect(textarea.readOnly).toBe(true);
    subscription.unsubscribe();
  });

  it("gives the focus up as a session starts", () => {
    const { textarea, subscription } = mount();
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    xrSession.set({} as XRSession);
    expect(document.activeElement).not.toBe(textarea);
    xrSession.set(null);
    expect(textarea.readOnly).toBe(false);
    subscription.unsubscribe();
  });
});

describe("the highlighted program", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("replaces the nodes of the line that changed, and no other line's", () => {
    const store = new AppStore();
    store.setCode("A=point(0, 0);\nB=point(4, 0);\nl=line(A, B);\n");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const subscription = just(host, [children(Editor(store))]).subscribe({});
    const lines = () => [...host.querySelectorAll("pre > div")];
    const before = lines();
    const nodesBefore = before.map((line) => [...line.childNodes]);
    expect(before.map((line) => line.textContent)).toEqual([
      "A=point(0, 0);",
      "B=point(4, 0);",
      "l=line(A, B);",
      "",
    ]);

    // What a drag of B writes: its own statement, and nothing else.
    const changed: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        changed.push(record.target);
      }
    });
    observer.observe(host.querySelector("pre > div")?.parentElement as Element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    store.setCode("A=point(0, 0);\nB=point(4.5, 0.25);\nl=line(A, B);\n");
    const records = observer.takeRecords();
    for (const record of records) {
      changed.push(record.target);
    }
    observer.disconnect();

    const after = lines();
    expect(after).toHaveLength(before.length);
    after.forEach((line, index) => expect(line).toBe(before[index]));
    expect(after[1].textContent).toBe("B=point(4.5, 0.25);");
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((target) => target === before[1])).toBe(true);
    for (const index of [0, 2, 3]) {
      const nodes = [...after[index].childNodes];
      expect(nodes).toHaveLength(nodesBefore[index].length);
      nodes.forEach((node, i) => expect(node).toBe(nodesBefore[index][i]));
    }
    subscription.unsubscribe();
  });
});
