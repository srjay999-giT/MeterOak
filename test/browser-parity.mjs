/** Capture every screen against one frozen API response, then compare PNG bytes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workspace = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = path.resolve(flag('--output', path.join(workspace, '.qa/after')));
const baseline = flag('--compare', null);
const allowOverflowFix = args.includes('--allow-overflow-fix');
const base = flag('--url', 'http://127.0.0.1:4520');
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):4520$/);
process.env.TMPDIR = path.join(workspace, '.qa-tmp');
if (!process.env.PLAYWRIGHT_MODULE) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(import.meta.dirname, '../.playwright');
}
await fs.mkdir(process.env.TMPDIR, { recursive: true });
await fs.mkdir(out, { recursive: true });
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = await fs.readFile(
  path.join(import.meta.dirname, 'fixtures/dashboard.json'),
  'utf8',
);
const browser = await playwright.chromium.launch({
  headless: true,
  downloadsPath: process.env.TMPDIR,
});
const context = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
  reducedMotion: 'reduce',
  serviceWorkers: 'block',
});
await context.addInitScript(() => {
  const ActualDate = Date;
  const now = new ActualDate('2026-09-25T12:27:01.031Z').getTime();
  window.Date = class extends ActualDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
});
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort('blockedbyclient');
  if (url.pathname === '/api/dashboard')
    return route.fulfill({ status: 200, contentType: 'application/json', body: fixture });
  return route.continue();
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const report = {
  fixture: createHash('sha256').update(fixture).digest('hex'),
  browser: browser.version(),
  captures: [],
  errors,
};
const pages = ['Overview', 'Models', 'Session history', 'Budgets', 'Insights', 'Connections'];
async function compareVisiblePixels(before, after, viewportWidth) {
  return page.evaluate(
    async ({ before, after, viewportWidth }) => {
      const decode = (source) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = `data:image/png;base64,${source}`;
        });
      const [oldImage, newImage] = await Promise.all([decode(before), decode(after)]);
      const removedHorizontalOverflow =
        oldImage.width > viewportWidth &&
        newImage.width === viewportWidth &&
        oldImage.height === newImage.height;
      if (!removedHorizontalOverflow)
        return { removedHorizontalOverflow, sameVisiblePixels: false };
      const pixels = (image) => {
        const canvas = document.createElement('canvas');
        canvas.width = viewportWidth;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const a = pixels(oldImage),
        b = pixels(newImage);
      const sameVisiblePixels = a.every((value, index) => value === b[index]);
      return {
        removedHorizontalOverflow,
        sameVisiblePixels,
        oldWidth: oldImage.width,
        newWidth: newImage.width,
        height: newImage.height,
      };
    },
    { before: before.toString('base64'), after: after.toString('base64'), viewportWidth },
  );
}
async function navigate(name) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if ((await menu.isVisible()) && !(await page.locator('.sidebar').isVisible())) await menu.click();
  await page
    .locator('.sidebar')
    .getByRole('button', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) })
    .click();
  await page
    .locator('h1')
    .filter({ hasText: name === 'Overview' ? 'Usage overview' : name })
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
}
try {
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(base);
    await page.locator('#meteroak-intro').waitFor({ state: 'detached' });
    for (const design of ['original', 'portfolio']) {
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(design);
      for (const name of pages) {
        await navigate(name);
        const file = `${design}-${width}-${name.toLowerCase().replaceAll(' ', '-')}.png`;
        const png = await page.screenshot({
          path: path.join(out, file),
          fullPage: true,
          animations: 'disabled',
        });
        const html = await page.locator('main').innerText();
        const entry = { file, sha256: createHash('sha256').update(png).digest('hex'), text: html };
        if (baseline) {
          const previous = await fs.readFile(path.join(path.resolve(baseline), file));
          entry.identical = png.equals(previous);
          if (!entry.identical && allowOverflowFix) {
            Object.assign(entry, await compareVisiblePixels(previous, png, width));
          }
        }
        report.captures.push(entry);
        console.log(
          entry.sameVisiblePixels
            ? 'OVERFLOW FIX'
            : entry.identical === false
              ? 'DIFFERENT'
              : 'CAPTURE',
          file,
        );
      }
    }
  }
  assert.equal(await page.title(), 'MeterOak');
  assert.equal(errors.length, 0, 'Unexpected JavaScript errors');
  if (baseline)
    assert.ok(
      report.captures.every(
        (c) =>
          c.identical || (allowOverflowFix && c.removedHorizontalOverflow && c.sameVisiblePixels),
      ),
      'Some screenshots differ from baseline',
    );
} finally {
  await fs.writeFile(path.join(out, 'parity.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
