import assert from "node:assert/strict";
import { test } from "node:test";
import { demoLinks, readmeSummary, repositoryUrl, rewriteLinks } from "./pages.mjs";

const pages = new Map([
  ["packages/signal", "/packages/signal"],
  ["packages/three", "/packages/three"],
]);
/** @type {Record<string, "file" | "directory">} */
const tree = {
  "packages/jsdom-env": "directory",
  "packages/three/src/render.js": "file",
  LICENSE: "file",
};
const lookup = (/** @type {string} */ path) => tree[path];
const rewrite = (/** @type {string} */ markdown) =>
  rewriteLinks(markdown, { from: "packages/justdom", pages, lookup });

test("a link to a package with a page goes to that page, anchor kept", () => {
  assert.equal(rewrite("[signal](../signal)").markdown, "[signal](/packages/signal)");
  assert.equal(rewrite("[a](../three#layers)").markdown, "[a](/packages/three#layers)");
  assert.equal(rewrite("[a](../signal/README.md)").markdown, "[a](/packages/signal)");
  assert.equal(rewrite("[`signal`](../signal)").markdown, "[`signal`](/packages/signal)");
});

test("any other relative link goes to GitHub, as a tree or a blob", () => {
  assert.equal(
    rewrite("[env](../jsdom-env)").markdown,
    `[env](${repositoryUrl}/tree/develop/packages/jsdom-env)`,
  );
  assert.equal(
    rewrite("[l](../../LICENSE)").markdown,
    `[l](${repositoryUrl}/blob/develop/LICENSE)`,
  );
  assert.equal(
    rewrite("[r](../three/src/render.js)").markdown,
    `[r](${repositoryUrl}/blob/develop/packages/three/src/render.js)`,
  );
});

test("an image goes to the raw file, even in a package with a page", () => {
  const result = rewriteLinks("![x](./shot.png)", {
    from: "packages/three",
    pages,
    lookup: () => "file",
  });
  assert.equal(result.markdown, `![x](${repositoryUrl}/raw/develop/packages/three/shot.png)`);
});

test("absolute links, anchors and links in code are left alone", () => {
  const markdown = [
    "[w](https://rushjs.io) [a](#usage) [r](/guide/)",
    "`[c](../signal)`",
    "```",
    "[c](../signal)",
    "```",
  ].join("\n");
  assert.equal(rewrite(markdown).markdown, markdown);
});

test("a link to a file not in the repository is reported", () => {
  const result = rewrite("[g](../../docs/signal-user-guide.md) [s](../signal)");
  assert.deepEqual(result.missing, ["docs/signal-user-guide.md"]);
});

test("a summary is the title and the first paragraph, links taken out", () => {
  const readme = "# Desk\n\nA desk drawn in\n[HTML](./x) and CSS.\n\nMore.\n";
  assert.deepEqual(readmeSummary(readme), {
    title: "Desk",
    summary: "A desk drawn in HTML and CSS.",
  });
});

test("a recorded demo shows its clip, or its still to a reader who wants less motion, linked to the demo", () => {
  const demo = { slug: "desk", title: 'The "Desk"', folder: "apps/desk", headset: false };
  const links = `<a href="/demos/desk/" target="_self">Open the demo</a> · [Source](${repositoryUrl}/tree/develop/apps/desk)`;
  assert.deepEqual(demoLinks(demo, false), [links, ""]);
  assert.deepEqual(demoLinks(demo, true), [
    '<a href="/demos/desk/" target="_self"><picture>' +
      '<source srcset="/screenshots/demos/desk.webp" media="(prefers-reduced-motion: reduce)">' +
      '<img src="/screenshots/demos/desk.anim.webp" alt="The &quot;Desk&quot;" ' +
      'width="1280" height="800" loading="lazy"></picture></a>',
    "",
    links,
    "",
  ]);
});

test("a demo that draws a headset session links to it under the emulator, in a new tab", () => {
  const demo = { slug: "euclid", title: "Euclid", folder: "apps/euclid", headset: true };
  assert.deepEqual(demoLinks(demo, false), [
    '<a href="/demos/euclid/" target="_self">Open the demo</a> · ' +
      '<a href="/demos/euclid/?emulator" target="_blank" rel="noopener">Play in a tab with an emulated headset</a> · ' +
      `[Source](${repositoryUrl}/tree/develop/apps/euclid)`,
    "",
  ]);
});
