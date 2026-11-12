#!/usr/bin/env node
// Clicks every button of the built justdom entry and checks what each one
// leaves in the table, with no server: the page opens from disk.
//
//   cd frameworks/keyed/justdom && npm ci && npm run build-prod && cd ../../..
//   npm ci && npx playwright install chromium
//   node check.mjs
//
// The suite's own `isKeyed` checks that rows keep their nodes; this checks
// that each button does what the benchmark expects of it.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(join(here, "frameworks/keyed/justdom/index.html")).href;

const browser = await chromium.launch();
try {
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error));
  await tab.goto(page);

  const rows = () => tab.locator("tbody tr").count();
  const cell = (row, column) =>
    tab.locator(`tbody tr:nth-child(${row}) td:nth-child(${column})`).textContent();
  // Without the suite's stylesheet the links have no size, so the clicks are
  // dispatched rather than aimed.
  const click = (selector) => tab.locator(selector).dispatchEvent("click");
  const clickRow = (row, column) => click(`tbody tr:nth-child(${row}) td:nth-child(${column}) a`);

  await click("#run");
  assert.equal(await rows(), 1000, "Create 1,000 rows");
  assert.equal(await cell(1, 1), "1");

  const first = await cell(1, 2);
  const second = await cell(2, 2);
  await click("#update");
  assert.equal(await cell(1, 2), `${first} !!!`, "Update every 10th row: row 1");
  assert.equal(await cell(2, 2), second, "Update every 10th row: row 2");

  const [row2, row999] = [await cell(2, 1), await cell(999, 1)];
  await click("#swaprows");
  assert.deepEqual([await cell(2, 1), await cell(999, 1)], [row999, row2], "Swap Rows");

  await clickRow(5, 2);
  assert.deepEqual(
    await tab.locator("tr.danger td:first-child").allTextContents(),
    [await cell(5, 1)],
    "select row 5",
  );
  await clickRow(7, 2);
  assert.deepEqual(
    await tab.locator("tr.danger td:first-child").allTextContents(),
    [await cell(7, 1)],
    "select row 7",
  );

  const row4 = await cell(4, 1);
  const removed = await cell(3, 1);
  await clickRow(3, 3);
  assert.equal(await rows(), 999, "remove row 3");
  assert.equal(await cell(3, 1), row4, `row ${removed} is gone`);

  await click("#add");
  assert.equal(await rows(), 1999, "Append 1,000 rows");
  await click("#runlots");
  assert.equal(await rows(), 10000, "Create 10,000 rows");
  await click("#clear");
  assert.equal(await rows(), 0, "Clear");

  assert.deepEqual(errors, [], "no errors on the page");
  console.log("Every button does what the benchmark expects.");
} finally {
  await browser.close();
}
