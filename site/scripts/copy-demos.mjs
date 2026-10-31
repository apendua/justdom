// Copies each demo's build into the site's, at the path its Vite `base`
// names: apps/desk/dist becomes dist/demos/desk/. Run it after
// `vitepress build`, which empties dist first.

import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { demos, root, site } from "./projects.mjs";

const all = demos();
for (const { projectFolder, slug } of all) {
  const folder = join(root, projectFolder);
  // Its pages and its service worker ask for /demos/<slug>/..., so a build
  // for any other base would load nothing once copied there.
  const config = readFileSync(join(folder, "vite.config.mts"), "utf8");
  if (!config.includes(`base: "/demos/${slug}/"`)) {
    throw new Error(`${projectFolder}/vite.config.mts does not build for /demos/${slug}/`);
  }
  const dist = join(folder, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(`${projectFolder} has no build; run rush build --to justdom-site`);
  }
  cpSync(dist, join(site, "dist", "demos", slug), { recursive: true });
}

console.log(`Copied ${all.length} demos into dist/demos/.`);
