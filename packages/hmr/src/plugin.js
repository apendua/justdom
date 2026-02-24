/**
 * @typedef {object} PackageConfiguration
 * @property {string[]} reloadable
 */

/**
 * @type {Record<string, PackageConfiguration>}
 */
const configuration = {
  "@apendua.dev/reactive": {
    reloadable: ["component"],
  },
  "@apendua.dev/store4": {
    reloadable: ["shareObservable"],
  },
  "@apendua.dev/dom": {
    reloadable: ["stylesheet", "className"],
  },
};

/**
 * @typedef {object} ImportDetails
 * @property {string} packageName
 */

/**
 * @typedef {object} DefinitionDetails
 * @property {string} name
 * @property {boolean} exported
 * @property {string} constructorName
 */

/**
 * @returns {import('vite').Plugin}
 */
export default function HMRPlugin() {
  return {
    name: "apendua:hmr",
    apply: "serve",
    transform(code, id, options = {}) {
      if ((options.ssr && !process.env.VITEST) || id.includes("node_modules")) {
        return;
      }

      /** @type {Record<string, ImportDetails>} */
      const allNames = {};

      const importsRegEx = /import\s+\{([\w\s,$]+)\}\s+from\s+['"]([\w.@/]+)['"];?/gm;
      /** @type {RegExpExecArray | null} */
      let importMatch;
      while ((importMatch = importsRegEx.exec(code))) {
        const packageName = importMatch[2];
        const packageConfig = configuration[packageName];
        if (!packageConfig) {
          continue;
        }
        const importedNames = importMatch[1].split(",").map((s) => s.trim());
        for (const name of importedNames) {
          // TODO: Add support for renamed imports (e.g. `import { component as _component } from "@apendua.dev/reactive";`)
          if (packageConfig.reloadable.includes(name)) {
            allNames[name] = { packageName };
          }
        }
      }

      if (Object.keys(allNames).length === 0) {
        return;
      }

      const definitionRegEx = /^(export\s+)?(const\s+(\w+)\s*=|default\s)\s*(\w+)([(`])/gm;
      /** @type {DefinitionDetails[]} */
      const allDefinitions = [];

      /** @type {RegExpExecArray | null} */
      let definitionMatch;
      while ((definitionMatch = definitionRegEx.exec(code))) {
        const constructorName = definitionMatch[4];
        if (!allNames[constructorName]) {
          continue;
        }
        allDefinitions.push({
          name: definitionMatch[3] || "default",
          exported: !!definitionMatch[1],
          constructorName,
        });
      }

      const defaultNameRegEx = /export\s+default\s+(\w+)/;
      const match = code.match(defaultNameRegEx);
      if (match) {
        const index = allDefinitions.findIndex((def) => def.name === match[1]);
        if (index !== -1) {
          allDefinitions[index].name = "default";
          allDefinitions[index].exported = true;
        }
      }

      if (allDefinitions.length === 0) {
        return;
      }

      const reloadables = allDefinitions
        .filter((definition) => definition.exported)
        .map((definition) => definition.name)
        .sort();

      const header = `import { $newReloader, $reloadable } from "@apendua.dev/hmr";`;
      const footer = `
if (import.meta.hot) {
  const reload = $newReloader();
  const reloadables = new Set(${JSON.stringify(reloadables)});
  import.meta.hot.on("beforeUpdate", () => {
    $newReloader();
  });
  import.meta.hot.accept((newModule) => {
    if (!newModule || Object.keys(newModule).some((key) => !reloadables.has(key))) {
      import.meta.hot.invalidate();
      return;
    }
    reload(newModule);
  });
}`;
      let i = 0;
      return `${header}\n${code.replace(definitionRegEx, (p0, p1, p2, p3, p4, p5) => {
        const definition = allDefinitions[i++];
        if (!definition || !definition.exported) {
          return p0;
        }
        return `${p1 ?? ""}${p2}$reloadable(${JSON.stringify(definition.name)}, ${p4})${p5}`;
      })}\n\n${footer}`;
    },
  };
}
