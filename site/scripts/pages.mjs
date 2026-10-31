// Writes the site's generated pages from what the repository already says, so
// that nothing is said twice:
//
//   packages/<folder>.md  each published package's README
//   packages/index.md     the published packages, from rush.json
//   demos/index.md        the demos this site serves, from their READMEs
//
// Both folders are generated whole and ignored by Git. Run it before
// `vitepress build` or `vitepress dev`; package.json's scripts do.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { demos, demoViewport, projects, readJson, root, screenshots, site } from "./projects.mjs";

/** Where a link to a file the site does not render goes instead. */
export const repositoryUrl = "https://github.com/apendua/justdom";

/**
 * Rewrites the relative links in a README for the page the site renders it
 * as. A link to another package that has a page becomes a link to that page;
 * any other relative link goes to the file on GitHub, since the site has no
 * copy of it. Absolute links and anchors are left as they are.
 *
 * @param {string} markdown
 * @param {object} options
 * @param {string} options.from the README's folder, relative to the root
 * @param {Map<string, string>} options.pages package folder to page path
 * @param {(path: string) => "file" | "directory" | undefined} options.lookup
 * @returns {{ markdown: string, missing: string[] }} the rewritten text, and
 *   the targets that are not in the repository
 */
export function rewriteLinks(markdown, { from, pages, lookup }) {
  /** @type {string[]} */
  const missing = [];
  // Inline links and images, `[text](target)` and `![alt](target)` with an
  // optional title, whose text may hold code spans. A code span outside a
  // link matches the second alternative and is kept as written, as is a
  // fenced block, which splitFences sets aside.
  const re = /(!?\[(?:[^\]`]|`[^`\n]*`)*\]\()([^)\s]+)((?:\s+"[^"]*")?\))|`[^`\n]+`/g;
  const rewritten = splitFences(markdown)
    .map(({ code, text }) =>
      code
        ? text
        : text.replace(re, (match, open, target, close) => {
            if (open === undefined || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return match;
            const [path, hash = ""] = target.split(/(?=#)/);
            const resolved = posix.normalize(posix.join(from, path)).replace(/\/$/, "");
            const page = pages.get(resolved.replace(/\/README\.md$/, ""));
            if (page && !open.startsWith("!")) return `${open}${page}${hash}${close}`;
            const kind = lookup(resolved);
            if (!kind) missing.push(resolved);
            const view = open.startsWith("!") ? "raw" : kind === "directory" ? "tree" : "blob";
            return `${open}${repositoryUrl}/${view}/develop/${resolved}${hash}${close}`;
          }),
    )
    .join("");
  return { markdown: rewritten, missing };
}

/**
 * Splits Markdown into its fenced code blocks and the text between them.
 *
 * @param {string} markdown
 * @returns {{ code: boolean, text: string }[]}
 */
function splitFences(markdown) {
  const parts = [];
  let last = 0;
  for (const match of markdown.matchAll(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm)) {
    parts.push({ code: false, text: markdown.slice(last, match.index) });
    parts.push({ code: true, text: match[0] });
    last = match.index + match[0].length;
  }
  parts.push({ code: false, text: markdown.slice(last) });
  return parts;
}

/**
 * The first paragraph of a README as plain text: the one under its title,
 * with the links taken out, since the demos page has nowhere for them to go.
 *
 * @param {string} markdown
 * @returns {{ title: string | undefined, summary: string | undefined }}
 */
export function readmeSummary(markdown) {
  const title = markdown.match(/^# (.+)$/m)?.[1].trim();
  const paragraph = markdown
    .replace(/^# .+$/m, "")
    .trim()
    .split(/\n\s*\n/)[0];
  const summary = paragraph
    ?.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return { title, summary: summary || undefined };
}

/**
 * The lines under a demo's heading on the demos page: its screenshot, when
 * scripts/screenshots.mjs has taken one, then the links to the demo and to its
 * source. The screenshot opens the demo too. A demo that draws a headset
 * session also gets a link that opens it in a new tab under `?emulator`, so
 * it can be played without a headset.
 *
 * The links to the demo are plain anchors with a target, so that VitePress's
 * router leaves them to the browser: the demo is a page of its own, not one
 * of the site's.
 *
 * @param {{ slug: string, title: string, folder: string, headset: boolean }} demo
 * @param {boolean} screenshot whether public/screenshots/demos/<slug>.webp exists
 * @returns {string[]}
 */
export function demoLinks(demo, screenshot) {
  const href = `/demos/${demo.slug}/`;
  const emulated = demo.headset
    ? `<a href="${href}?emulator" target="_blank" rel="noopener">Play in a tab with an emulated headset</a> · `
    : "";
  return [
    ...(screenshot
      ? [
          `<a href="${href}" target="_self"><img src="/screenshots/demos/${demo.slug}.webp" ` +
            `alt="${demo.title.replace(/"/g, "&quot;")}" width="${demoViewport.width}" height="${demoViewport.height}" loading="lazy"></a>`,
          "",
        ]
      : []),
    `<a href="${href}" target="_self">Open the demo</a> · ` +
      emulated +
      `[Source](${repositoryUrl}/tree/develop/${demo.folder})`,
    "",
  ];
}

/** @param {string} path relative to the root */
function lookup(path) {
  const full = join(root, path);
  if (!existsSync(full)) return undefined;
  return statSync(full).isDirectory() ? "directory" : "file";
}

/** Escapes text for a Markdown table cell. */
const cell = (/** @type {string} */ text) => text.replace(/\|/g, "\\|");

function main() {
  const published = projects()
    .filter((project) => project.versionPolicyName === "publishable")
    .map((project) => ({
      ...project,
      slug: posix.basename(project.projectFolder),
      manifest: readJson(join(root, project.projectFolder, "package.json")),
      hasReadme: existsSync(join(root, project.projectFolder, "README.md")),
    }));

  const pages = new Map(
    published.filter((p) => p.hasReadme).map((p) => [p.projectFolder, `/packages/${p.slug}`]),
  );

  const packagesDir = join(site, "packages");
  rmSync(packagesDir, { recursive: true, force: true });
  mkdirSync(packagesDir, { recursive: true });

  const missing = new Set();
  for (const p of published.filter((p) => p.hasReadme)) {
    const readme = readFileSync(join(root, p.projectFolder, "README.md"), "utf8");
    const result = rewriteLinks(readme, { from: p.projectFolder, pages, lookup });
    for (const path of result.missing) missing.add(`${p.projectFolder}/README.md -> ${path}`);
    const source = `${repositoryUrl}/blob/develop/${p.projectFolder}/README.md`;
    writeFileSync(
      join(packagesDir, `${p.slug}.md`),
      `<!-- Generated from ${p.projectFolder}/README.md by site/scripts/pages.mjs. -->\n\n` +
        `${result.markdown.trimEnd()}\n\n---\n\nThis page is the package's [README](${source}).\n`,
    );
  }

  const rows = published.map((p) => {
    const name = p.hasReadme ? `[\`${p.packageName}\`](./${p.slug})` : `\`${p.packageName}\``;
    return `| ${name} | ${p.manifest.version} | ${cell(p.manifest.description ?? "")} |`;
  });
  writeFileSync(
    join(packagesDir, "index.md"),
    [
      "<!-- Generated from rush.json by site/scripts/pages.mjs. -->",
      "",
      "# Packages",
      "",
      "Every package here is published to npm. Each page is the package's README.",
      "",
      "| Package | Version | What it is |",
      "| --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );

  const served = demos()
    .map((project) => {
      const folder = project.projectFolder;
      const readme = join(root, folder, "README.md");
      const html = readFileSync(join(root, folder, "index.html"), "utf8");
      const fallback = html.match(/<title>([^<]*)<\/title>/)?.[1].trim();
      const { title, summary } = existsSync(readme)
        ? readmeSummary(readFileSync(readme, "utf8"))
        : { title: undefined, summary: undefined };
      // A demo that draws a headset session does it with justdom-xr, whose
      // emulator every such demo installs behind `?emulator`.
      const manifest = readJson(join(root, folder, "package.json"));
      const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
      return {
        folder,
        slug: project.slug,
        title: title ?? fallback ?? folder,
        summary,
        headset: "justdom-xr" in dependencies,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  const demosDir = join(site, "demos");
  rmSync(demosDir, { recursive: true, force: true });
  mkdirSync(demosDir, { recursive: true });
  writeFileSync(
    join(demosDir, "index.md"),
    [
      "<!-- Generated from the demos' READMEs by site/scripts/pages.mjs. -->",
      "",
      "# Demos",
      "",
      "Each demo is a full app built on these packages. The ones that draw a headset session",
      "open in a browser too, with an emulated headset behind `?emulator`: the link to play one",
      "in a tab opens it that way.",
      "",
      ...served.flatMap((demo) => [
        // The heading is plain text, since VitePress makes its permalink's
        // label from the heading's source, markup included.
        `## ${demo.title}`,
        "",
        ...(demo.summary ? [demo.summary, ""] : []),
        ...demoLinks(demo, existsSync(join(screenshots, "demos", `${demo.slug}.webp`))),
      ]),
    ].join("\n"),
  );

  // Printed rather than raised: a warning fails `rush build`, and which of
  // apendua.dev's docs come here is still open in docs/migration-plan.md.
  if (missing.size) {
    console.log(
      `These READMEs link to files that are not in this repository:\n  ${[...missing].join("\n  ")}`,
    );
  }
  console.log(`Wrote ${pages.size} package pages and ${served.length} demos.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
