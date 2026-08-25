const pluginJs = require("./common/autoinstallers/rush-lint-staged/node_modules/@eslint/js");
const configPrettier = require("./common/autoinstallers/rush-lint-staged/node_modules/eslint-config-prettier");
const globals = require("./common/autoinstallers/rush-lint-staged/node_modules/globals");
const parser = require("./common/autoinstallers/rush-lint-staged/node_modules/@typescript-eslint/parser/dist/index.js");

module.exports = [
  {
    ...pluginJs.configs.recommended,
    ignores: ["common/scripts/**/*.js", "common/config/rush/.pnpmfile.cjs"],
    languageOptions: {
      parser,
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: [
      "packages/justdom/src/**/*.js",
      "packages/three/src/**/*.js",
      "packages/three-ui/src/**/*.js",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // A visual test runs in node and talks about the page: the bodies it hands
    // to `page.evaluate` are written here and executed in the browser, so both
    // sets of globals are in scope in the same file.
    files: [
      "apps/*/tests/**/*.{js,mjs}",
      "apps/*/bench/**/*.{js,mjs}",
      "packages/*/bench/**/*.{js,mjs}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    ...configPrettier,
  },
];
