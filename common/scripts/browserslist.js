const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const browserslistPath = path.resolve(
  __dirname,
  '..',
  'autoinstallers',
  'browserslist-tools',
  'node_modules',
  '.bin',
  'browserslist'
);

const configPath = path.resolve(__dirname, '..', 'config', '.browserslistrc');
const outputPath = path.resolve(process.cwd(), '.browserslistrc');

// Get command line arguments to pass to browserslist
const args = process.argv.slice(2);

try {
  // Run browserslist with the config and capture output
  const output = execSync(`${browserslistPath} --config="${configPath}" ${args.join(' ')}`, {
    encoding: 'utf-8'
  });

  // Write output to .browserslistrc file
  fs.writeFileSync(outputPath, output);

  console.log(`Browser list written to ${outputPath}`);
} catch (error) {
  console.error(`Error running browserslist: ${error.message}`);
  process.exit(1);
}