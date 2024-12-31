/** @type {import('ts-jest/dist/types').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  reporters: ["jest-silent-reporter"],
  silent: true,
  rootDir: "./lib",
};
