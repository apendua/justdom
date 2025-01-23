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

      const factoryImportRegEx =
        /import\s+\{\s*\$factory\s*\}\s+from\s+['"]@apendua\.dev\/hmr['"];?/;
      if (!factoryImportRegEx.test(code)) {
        return;
      }

      const namesRegEx = /^(export\s+)?const\s+(\w+)\s*=\s*\$factory\(/gm;
      /** @type {string[]} */
      const names = [];
      /** @type {RegExpExecArray | null} */
      let match;
      while ((match = namesRegEx.exec(code))) {
        names.push(match[2]);
      }

      const defaultFactoryRegEx = /export\s+default\s+\$factory\(/;
      if (defaultFactoryRegEx.test(code)) {
        names.push("default");
      } else {
        const defaultNameRegEx = /export\s+default\s+(\w+);/;
        const match = code.match(defaultNameRegEx);
        if (match) {
          const index = names.indexOf(match[1]);
          if (index !== -1) {
            names[index] = "default";
          }
        }
      }

      if (names.length === 0) {
        return;
      }

      const footer = `
if (import.meta.hot) {
  import.meta.hot.on("beforeUpdate", () => {
    $factory.get();
  });
  const names = ${JSON.stringify(names)};
  const factories = $factory.get();
  import.meta.hot.accept((newModule) => {
    if (!newModule) {
      return;
    }
    if (!Object.keys(newModule).every((key) => names.includes(key))) {
      return;
    }
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (newModule[name]) {
        factories[i].next(newModule[name]);
      }
    }
  });
}`;
      return `${code}\n\n${footer}`;
    },
  };
}
