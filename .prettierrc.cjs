module.exports = {
  trailingComma: "all",
  printWidth: 100,
  plugins: [
    require("./common/autoinstallers/rush-lint-staged/node_modules/prettier-plugin-packagejson"),
    require("./common/autoinstallers/rush-lint-staged/node_modules/prettier-plugin-svelte"),
  ],
};
