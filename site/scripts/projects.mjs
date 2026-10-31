// What the site's scripts read about the repository: its Rush projects, and
// which of them are the demos the site serves.

import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/** The site's folder. */
export const site = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The repository's root. */
export const root = join(site, "..");

/**
 * Reads a JSON file that may hold comments, as rush.json does.
 *
 * @param {string} path
 */
export function readJson(path) {
  const text = readFileSync(path, "utf8").replace(/^\s*\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  return JSON.parse(text);
}

/**
 * @typedef {{ packageName: string, projectFolder: string, versionPolicyName?: string }} Project
 */

/** @returns {Project[]} every project in rush.json */
export function projects() {
  return readJson(join(root, "rush.json")).projects;
}

/**
 * The demos, which are the site's "workspace:*" dependencies: Rush builds
 * them before the site for that reason, and the site serves each one at
 * `/demos/<slug>/`, where the slug is its folder's name.
 *
 * @returns {(Project & { slug: string })[]}
 */
export function demos() {
  /** @type {Record<string, string>} */
  const dependencies = readJson(join(site, "package.json")).devDependencies;
  const all = projects();
  return Object.entries(dependencies)
    .filter(([, range]) => range === "workspace:*")
    .map(([name]) => {
      const project = all.find((p) => p.packageName === name);
      if (!project) throw new Error(`${name} is not a project in rush.json`);
      return { ...project, slug: posix.basename(project.projectFolder) };
    });
}
