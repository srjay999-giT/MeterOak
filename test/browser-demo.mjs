/** Verify the static demo without a reader, using an isolated browser profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(root, '../.qa/demo');
process.env.TMPDIR = path.resolve(root, '../.qa-tmp');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.playwright');
const { chromium } = createRequire(import.meta.url)('playwright');
await fs.mkdir(output, { recursive: true });
await fs.mkdir(process.env.TMPDIR, { recursive: true });
const remote = process.argv.includes('--remote');
const base = remote
  ? 'https://srjay999-git.github.io/MeterOak/'
  : 'http://127.0.0.1:4520/MeterOak/';
const origin = new URL(base).origin;
const browser = await chromium.launch({ headless: true, downloadsPath: output });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'en-US',
  reducedMotion: 'reduce',
  serviceWorkers: 'block',
});
const errors = [];
const requests = [];
const pages = ['Overview', 'Models', 'Session history', 'Budgets', 'Insights', 'Connections'];
const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  requests.push(url.href);
  if (url.origin !== origin || !url.pathname.startsWith('/MeterOak/')) {
    errors.push(`Unexpected request: ${url.origin}${url.pathname}`);
    return route.abort();
  }
  if (remote) return route.continue();
  const name = url.pathname.slice('/MeterOak/'.length) || 'index.html';
  const file = path.resolve(root, 'dist-demo', name);
  assert(file.startsWith(path.join(root, 'dist-demo') + path.sep));
  try {
    return route.fulfill({
      status: 200,
      contentType: contentTypes[path.extname(file)] || 'application/octet-stream',
      body: await fs.readFile(file),
    });
  } catch {
    errors.push(`Missing demo asset: ${name}`);
    return route.fulfill({ status: 404, body: 'Missing demo asset' });
  }
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
});
page.setDefaultTimeout(15000);
async function navigate(name) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if ((await menu.isVisible()) && !(await page.locator('.sidebar.is-open').count())) {
    await menu.click();
  }
  await page
    .locator('.sidebar')
    .getByRole('button', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) })
    .click();
  assert.equal(await page.locator('h1').innerText(), name === 'Overview' ? 'Usage overview' : name);
  assert(await page.getByRole('note', { name: 'Demo data notice' }).isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}
try {
  await page.goto(base);
  await page.locator('#meteroak-intro').waitFor({ state: 'detached' });
  assert.equal(
    await page.getByRole('combobox', { name: 'Appearance', exact: true }).inputValue(),
    'portfolio',
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const name of pages) await navigate(name);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigate('Session history');
  await page
    .getByRole('button', { name: /^View session / })
    .first()
    .click();
  assert(await page.getByRole('dialog').isVisible());
  await page.keyboard.press('Escape');
  await navigate('Budgets');
  await page.getByLabel('30-day target (USD)').fill('2400');
  await page.getByRole('button', { name: 'Save target', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  assert.match((await downloadEvent).suggestedFilename(), /^meteroak-demo-/);
  await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('original');
  await page.reload();
  await page.locator('#meteroak-intro').waitFor({ state: 'detached' });
  assert.equal(
    await page.getByRole('combobox', { name: 'Appearance', exact: true }).inputValue(),
    'original',
  );
  await navigate('Budgets');
  assert.equal(await page.getByLabel('30-day target (USD)').inputValue(), '2400');
  const keys = await page.evaluate(() => Object.keys(localStorage));
  assert(keys.every((key) => key.startsWith('meteroak.demo.')));
  await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('portfolio');
  await navigate('Overview');
  await page.getByRole('combobox', { name: 'Usage source', exact: true }).selectOption('opencode');
  assert.match(
    await page.locator('main').innerText(),
    /No usage|No sessions|No recorded|No local|0/,
  );
  await page.getByRole('combobox', { name: 'Usage source', exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Reload sample data', exact: true }).click();
  await page.screenshot({
    path: path.join(output, remote ? 'live-demo.png' : 'static-demo.png'),
    fullPage: true,
  });
  assert(!requests.some((url) => url.includes('/api/')));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      base,
      pages: pages.length,
      widths: [1440, 390],
      requests: requests.length,
      errors,
      result: 'passed',
    }),
  );
} finally {
  await browser.close();
}
