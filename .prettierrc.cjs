module.exports = {
  trailingComma: "all",
  printWidth: 100,
  proseWrap: "always",
  plugins: [
    require("./common/autoinstallers/rush-lint-staged/node_modules/prettier-plugin-packagejson"),
  ],
};
