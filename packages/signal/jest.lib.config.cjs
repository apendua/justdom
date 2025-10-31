/** @type {import('ts-jest/dist/types').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "jsdom",
  reporters: ["jest-silent-reporter"],
  silent: true,
  rootDir: "./lib",
};
