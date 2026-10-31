const path = require('path');
const { exec } = require('child_process');
const { exists } = require('fs');
const { extname } = require('path');
const { promisify } = require('util');

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function parseOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const fromCommit = parseOption('--from-commit');
const allowedExtensions = [
  '.js',
  '.cjs',
  '.mjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.svelte',
];

const eslintPath = path.resolve(
  __dirname,
  '..',
  'autoinstallers',
  'rush-lint-staged',
  'node_modules',
  '.bin',
  'eslint',
);

(async () => {
  /** @type {string | undefined} */
  let stdout;
  /** @type {string | undefined} */
  let stderr;
  if (fromCommit) {
    ({ stdout } = await promisify(exec)(
      `git diff --name-only ${fromCommit} HEAD`,
    ));
  } else {
    ({ stdout } = await promisify(exec)('git diff --name-only --cached'));
  }
  const changedFiles = stdout.split('\n').filter(Boolean);
  /** @type {string[]} */
  const filesToCheck = [];
  for (const file of changedFiles) {
    const fileExists = await promisify(exists)(file);
    if (fileExists) {
      const extension = extname(file);
      if (allowedExtensions.includes(extension)) {
        filesToCheck.push(file);
      }
    }
  }
  if (filesToCheck.length === 0) {
    return;
  }
  try {
    ({ stdout, stderr } = await promisify(exec)(
      `${eslintPath} ${filesToCheck
        .map((file) => JSON.stringify(file))
        .join(' ')}`,
    ));
  } catch (err) {
    if (err.code === 1) {
      if (err.stdout) {
        console.log(err.stdout);
      }
      if (err.stderr) {
        console.log(err.stderr);
      }
      throw new Error('Some files are violating linter rules');
    }
    throw err;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
