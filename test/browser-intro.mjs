/** Opening sequence checks use an isolated profile and a frozen local response. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const workspace = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = path.resolve(option('--output', path.join(workspace, '.qa/intro')));
const comparePath = option('--compare', null);
const builtAssets = args.includes('--build') ? path.resolve(import.meta.dirname, '../dist') : null;
const base = option('--url', 'http://127.0.0.1:4520');
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):4520$/);
process.env.TMPDIR = path.join(workspace, '.qa-tmp');
if (!process.env.PLAYWRIGHT_MODULE) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(import.meta.dirname, '../.playwright');
}
await fs.mkdir(process.env.TMPDIR, { recursive: true });
await fs.mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await playwright.chromium.launch({
  headless: true,
  downloadsPath: process.env.TMPDIR,
});
const fixture = await fs.readFile(
  path.join(import.meta.dirname, 'fixtures/dashboard.json'),
  'utf8',
);
const report = { browser: browser.version(), cases: [], geometry: [] };
let page;
async function test(name, run) {
  try {
    const details = await run();
    report.cases.push({ name, status: 'passed', ...details });
    console.log('PASS', name);
  } catch (error) {
    report.cases.push({ name, status: 'failed', error: String(error.stack || error) });
    console.log('FAIL', name, error.message);
  }
}
async function openContext({
  motion = 'no-preference',
  width = 1600,
  height = 1000,
  mode = 'normal',
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: motion,
    serviceWorkers: 'block',
  });
  const timers = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort('blockedbyclient');
    if (
      mode === 'bundle-failure' &&
      (/\/src\/main\.(jsx|tsx)$/.test(url.pathname) || /^\/assets\/.*\.js$/.test(url.pathname))
    )
      return route.abort('failed');
    if (url.pathname === '/api/dashboard') {
      if (mode === 'slow-reader')
        await new Promise((resolve) => timers.push(setTimeout(resolve, 11500)));
      return route
        .fulfill({ status: 200, contentType: 'application/json', body: fixture })
        .catch(() => {});
    }
    if (builtAssets) {
      const file = path.join(builtAssets, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(`${builtAssets}${path.sep}`)) return route.abort('blockedbyclient');
      const contentType =
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.woff2': 'font/woff2',
        }[path.extname(file)] || 'application/octet-stream';
      try {
        return route.fulfill({ status: 200, contentType, body: await fs.readFile(file) });
      } catch {
        return route.fulfill({ status: 404, body: 'Not found' });
      }
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  return {
    context,
    page,
    close: async () => {
      timers.forEach(clearTimeout);
      await context.close();
    },
  };
}
async function geometry(page) {
  return page.evaluate(() => {
    const selectors = [
      '.meteroak-intro-brand',
      '.meteroak-intro-center',
      '.meteroak-intro-mark',
      '.meteroak-intro-progress',
      '.meteroak-intro-label',
      '.meteroak-intro-caption',
    ];
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      const r = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        color: style.color,
        font: style.font,
        overflow: r.x < -1 || r.right > innerWidth + 1 || r.y < -1 || r.bottom > innerHeight + 1,
      };
    });
  });
}
try {
  await test('Opening and reload retain approximately ten seconds, progress arc, and focus protection', async () => {
    const run = await openContext();
    page = run.page;
    try {
      const start = Date.now();
      await page.goto(base);
      assert.equal(await page.locator('#root').evaluate((root) => root.inert), true);
      await page.waitForTimeout(5000);
      const progress = await page.locator('.meteroak-intro-percentage').textContent();
      assert.ok(
        parseInt(progress) >= 48 && parseInt(progress) <= 66,
        `Unexpected midpoint ${progress}`,
      );
      const separation = await page.evaluate(() => {
        const arc = document.querySelector('#meteroak-intro-arc');
        const value = Number(
          document.querySelector('.meteroak-intro-arc-fill').style.strokeDashoffset,
        );
        const p = arc.getPointAtLength((arc.getTotalLength() * (100 - value)) / 100);
        const dot = document.querySelector('.meteroak-intro-dot');
        return Math.hypot(
          p.x - Number(dot.getAttribute('cx')),
          p.y - Number(dot.getAttribute('cy')),
        );
      });
      assert.ok(separation < 0.5, 'Dot follows the progress arc');
      await page.locator('#meteroak-intro').waitFor({ state: 'detached' });
      const openingMs = Date.now() - start;
      assert.ok(openingMs >= 9700 && openingMs < 11700, `Opening took ${openingMs}ms`);
      assert.equal(await page.locator('#root').evaluate((root) => root.inert), false);
      const reloadStart = Date.now();
      await page.reload();
      await page.locator('#meteroak-intro').waitFor({ state: 'detached' });
      const reloadMs = Date.now() - reloadStart;
      assert.ok(reloadMs >= 9700 && reloadMs < 11700, `Reload took ${reloadMs}ms`);
      await page.getByRole('button', { name: 'Models', exact: true }).click();
      assert.equal(
        await page.locator('#meteroak-intro').count(),
        0,
        'Navigation does not replay intro',
      );
      return { openingMs, reloadMs, midpoint: progress, dotDistance: separation };
    } finally {
      await run.close();
    }
  });
  await test('Reduced motion opens promptly once ready', async () => {
    const run = await openContext({ motion: 'reduce' });
    page = run.page;
    try {
      const start = Date.now();
      await page.goto(base);
      await page.locator('#meteroak-intro').waitFor({ state: 'detached' });
      const durationMs = Date.now() - start;
      assert.ok(durationMs < 3000, `Reduced motion took ${durationMs}ms`);
      assert.equal(await page.locator('#root').evaluate((root) => root.inert), false);
      return { durationMs };
    } finally {
      await run.close();
    }
  });
  for (const [width, height] of [
    [1600, 1000],
    [390, 844],
    [667, 375],
    [319, 568],
  ]) {
    await test(`Loader fits ${width}×${height}`, async () => {
      const run = await openContext({ width, height });
      page = run.page;
      try {
        await page.goto(base);
        await page.evaluate(() => document.fonts.ready);
        const measured = await geometry(page);
        report.geometry.push({ width, height, elements: measured });
        assert.deepEqual(
          measured.filter((entry) => entry.overflow),
          [],
        );
        await page.screenshot({ path: path.join(out, `loader-${width}x${height}.png`) });
      } finally {
        await run.close();
      }
    });
  }
  await test('Slow reader releases intro at its deadline', async () => {
    const run = await openContext({ mode: 'slow-reader' });
    page = run.page;
    try {
      const start = Date.now();
      await page.goto(base);
      await page.locator('#meteroak-intro').waitFor({ state: 'detached' });
      const durationMs = Date.now() - start;
      assert.ok(
        durationMs >= 10100 && durationMs < 11900,
        `Slow reader reveal took ${durationMs}ms`,
      );
      assert.equal(await page.locator('#root').evaluate((root) => root.inert), false);
      return { durationMs };
    } finally {
      await run.close();
    }
  });
  await test('Failed frontend bundle offers retry and stops progress', async () => {
    const run = await openContext({ mode: 'bundle-failure' });
    page = run.page;
    try {
      await page.goto(base);
      await page.getByText('Taking longer than expected', { exact: true }).waitFor();
      assert.equal(
        await page.getByRole('link', { name: 'Try again', exact: true }).isVisible(),
        true,
      );
      assert.equal(await page.locator('.meteroak-intro-progress').isVisible(), false);
      assert.equal(await page.locator('#root').evaluate((root) => root.inert), true);
    } finally {
      await run.close();
    }
  });
  if (comparePath) {
    await test('Loader dimensions, placement, colors, and fonts match baseline', async () => {
      const before = JSON.parse(await fs.readFile(path.resolve(comparePath), 'utf8'));
      assert.deepEqual(report.geometry, before.geometry);
    });
  }
} finally {
  report.summary = {
    passed: report.cases.filter((c) => c.status === 'passed').length,
    failed: report.cases.filter((c) => c.status === 'failed').length,
  };
  await fs.writeFile(path.join(out, 'intro.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.summary.failed) process.exitCode = 1;
