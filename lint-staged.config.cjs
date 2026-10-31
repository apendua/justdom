const path = require("path");

const prettierPath = path.resolve(
  __dirname,
  "common",
  "autoinstallers",
  "rush-lint-staged",
  "node_modules",
  ".bin",
  "prettier",
);

module.exports = {
  "*.{cjs,mjs,js,jsx,ts,tsx,json,md}": [`${prettierPath} --write`],
};
