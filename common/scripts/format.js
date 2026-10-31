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

/**
 * @param {string} name
 * @returns {boolean}
 */
function parseFlag(name) {
  return process.argv.indexOf(name) >= 0;
}

const fromCommit = parseOption('--from-commit');
const checkFormatting = parseFlag('--check-formatting');
const allowedExtensions = [
  '.js',
  '.cjs',
  '.mjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
];

const prettierPath = path.resolve(
  __dirname,
  '..',
  'autoinstallers',
  'rush-lint-staged',
  'node_modules',
  '.bin',
  'prettier',
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
  const filesToFormat = [];
  for (const file of changedFiles) {
    const fileExists = await promisify(exists)(file);
    if (fileExists) {
      const extension = extname(file);
      if (allowedExtensions.includes(extension)) {
        filesToFormat.push(file);
      }
    }
  }
  if (filesToFormat.length === 0) {
    return;
  }
  if (checkFormatting) {
    try {
      ({ stdout, stderr } = await promisify(exec)(
        `${prettierPath} --check ${filesToFormat
          .map((file) => JSON.stringify(file))
          .join(' ')}`,
      ));
      console.log(stdout);
      console.log(stderr);
      if (stderr) {
        throw new Error('Some files are not formatted');
      }
    } catch (err) {
      if (err.stdout) {
        console.log(err.stdout);
      }
      if (err.code === 1 && err.stderr) {
        console.log(err.stderr);
        throw new Error('Some files are not formatted');
      }
      throw err;
    }
  } else {
    ({ stdout, stderr } = await promisify(exec)(
      `${prettierPath} --write ${filesToFormat
        .map((file) => JSON.stringify(file))
        .join(' ')}`,
    ));
    console.log(stdout);
    console.log(stderr);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
