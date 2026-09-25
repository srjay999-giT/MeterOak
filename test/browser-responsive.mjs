/** Layout checks for short laptops and narrow phones, using one frozen API fixture. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const workspace = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = path.resolve(flag('--output', path.join(workspace, '.qa/responsive')));
const baselinePath = flag('--compare', null);
const base = flag('--url', 'http://127.0.0.1:4520');
const measureOnly = args.includes('--measure-only');
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):4520$/);
process.env.TMPDIR = path.join(workspace, '.qa-tmp');
if (!process.env.PLAYWRIGHT_MODULE)
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(import.meta.dirname, '../.playwright');
await fs.mkdir(process.env.TMPDIR, { recursive: true });
await fs.mkdir(out, { recursive: true });
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = await fs.readFile(
  path.join(import.meta.dirname, 'fixtures/dashboard.json'),
  'utf8',
);
const before = baselinePath
  ? JSON.parse(await fs.readFile(path.resolve(baselinePath, 'measurements.json'), 'utf8'))
  : null;
const browser = await chromium.launch({ headless: true, downloadsPath: process.env.TMPDIR });
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
const report = {
  browser: browser.version(),
  captures: [],
  errors: [],
  failures: [],
  assertions: 0,
};
page.on('pageerror', (e) => report.errors.push(e.message));
const pages = ['Overview', 'Models', 'Session history', 'Budgets', 'Insights', 'Connections'];
const check = (condition, view, message) => {
  report.assertions++;
  if (!condition) report.failures.push({ view, message });
};
const norm = (value) => value.replace(/\s+/g, ' ').trim();
try {
  for (const [width, height] of [
    [1280, 720],
    [1440, 800],
    [1600, 1000],
    [390, 844],
    [320, 700],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(base);
    await page.locator('#meteroak-intro').waitFor({ state: 'detached' });
    for (const design of ['portfolio', 'original']) {
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(design);
      for (const name of pages) {
        const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
        if ((await menu.isVisible()) && !(await page.locator('.sidebar').isVisible()))
          await menu.click();
        await page
          .locator('.sidebar')
          .getByRole('button', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) })
          .click();
        await page
          .locator('h1')
          .filter({ hasText: name === 'Overview' ? 'Usage overview' : name })
          .waitFor();
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          return document.fonts.ready;
        });
        await page.mouse.move(1, 1);
        await page.waitForTimeout(80);
        const file = `${design}-${width}-${name.toLowerCase().replaceAll(' ', '-')}.png`;
        const metrics = await page.evaluate(() => {
          const rect = (e) => {
            if (!e) return null;
            const r = e.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              bottom: r.bottom,
              right: r.right,
            };
          };
          const selectors = [
            '.topbar',
            '.main-content',
            '.page-heading',
            '.eyebrow',
            'h1',
            '.filter-bar',
            '.stats-grid',
            '.dashboard-grid',
            '.chart-panel',
            '.sidebar',
            '.sidebar-bottom',
          ];
          const boxes = Object.fromEntries(
            selectors.map((s) => [s, rect(document.querySelector(s))]),
          );
          const visible = (e) =>
            e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
          const controls = [...document.querySelectorAll('button,select,input,summary,a')].filter(
            visible,
          );
          const offscreen = controls
            .filter(
              (e) =>
                !e.closest('.table-scroll') &&
                (e.getBoundingClientRect().left < -1 ||
                  e.getBoundingClientRect().right > innerWidth + 1),
            )
            .map((e) => ({
              label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 60),
              class: e.className,
              ...rect(e),
            }));
          const primaryTargets = [
            ...document.querySelectorAll(
              '.mobile-menu,.heading-actions button,.appearance-control select,.filter-bar select',
            ),
          ]
            .filter(visible)
            .map((e) => ({
              label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 60),
              ...rect(e),
            }));
          const sidebar = document.querySelector('.sidebar');
          return {
            viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            documentHeight: document.documentElement.scrollHeight,
            boxes,
            headerGap: boxes['.page-heading'].y - boxes['.topbar'].bottom,
            offscreen,
            primaryTargets,
            sidebar: {
              clientHeight: sidebar.clientHeight,
              scrollHeight: sidebar.scrollHeight,
              overflowY: getComputedStyle(sidebar).overflowY,
            },
            text: document.querySelector('main').innerText,
          };
        });
        await page.screenshot({
          path: path.join(out, file),
          fullPage: true,
          animations: 'disabled',
        });
        check(metrics.documentWidth <= width + 1, file, 'Page must fit viewport width');
        check(!metrics.offscreen.length, file, 'Controls must not be cut off outside the viewport');
        check(
          metrics.headerGap >= 0 && metrics.headerGap <= 20,
          file,
          'Header-to-heading gap must be compact (0–20px)',
        );
        if (width <= 640)
          check(
            metrics.primaryTargets.every((t) => t.height >= 40 && t.width >= 40),
            file,
            'Primary mobile controls need a 40px minimum target',
          );
        if (before) {
          const old = before.captures.find((c) => c.file === file);
          check(Boolean(old), file, 'Matching baseline must exist');
          if (old)
            check(
              norm(metrics.text) === norm(old.text),
              file,
              'All visible main content must remain unchanged',
            );
        }
        const scrollAreas = await page.locator('.table-scroll').evaluateAll((elements) =>
          elements
            .filter((e) => e.checkVisibility())
            .map((e) => {
              const original = e.scrollLeft;
              e.scrollLeft = e.scrollWidth;
              const moved = e.scrollLeft;
              e.scrollLeft = original;
              return { width: e.clientWidth, scrollWidth: e.scrollWidth, moved };
            }),
        );
        check(
          scrollAreas.every((a) => a.scrollWidth <= a.width + 1 || a.moved > 0),
          file,
          'Wide data tables must remain scrollable',
        );
        const reachable = await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          const last = document.querySelector('main').lastElementChild;
          return last.getBoundingClientRect().bottom <= innerHeight + 1;
        });
        check(reachable, file, 'End of page content must be reachable by scrolling');
        await page.evaluate(() => window.scrollTo(0, 0));
        report.captures.push({ file, design, page: name, ...metrics, scrollAreas });
        console.log('CAPTURE', file, `gap=${metrics.headerGap}px`);
      }
      if (width <= 640) {
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
        const sidebarReachable = await page.locator('.sidebar').evaluate((e) => {
          const original = e.scrollTop;
          e.scrollTop = e.scrollHeight;
          const bottom = e.querySelector('.sidebar-bottom').getBoundingClientRect().bottom;
          const reachable = bottom <= e.getBoundingClientRect().bottom + 1;
          e.scrollTop = original;
          return reachable;
        });
        check(
          sidebarReachable,
          `${design}-${width}-drawer`,
          'All sidebar content must be reachable',
        );
        await page.keyboard.press('Escape');
        check(
          !(await page.locator('.sidebar').isVisible()),
          `${design}-${width}-drawer`,
          'Escape must close the drawer',
        );
      } else {
        const sidebarReachable = await page.locator('.sidebar').evaluate((e) => {
          const original = e.scrollTop;
          e.scrollTop = e.scrollHeight;
          const bottom = e.querySelector('.sidebar-bottom').getBoundingClientRect().bottom;
          const reachable = bottom <= e.getBoundingClientRect().bottom + 1;
          e.scrollTop = original;
          return reachable;
        });
        check(
          sidebarReachable,
          `${design}-${width}-sidebar`,
          'All sidebar content must be reachable',
        );
      }
    }
  }
  check(report.errors.length === 0, 'browser', 'No unexpected browser JavaScript errors');
} finally {
  await fs.writeFile(path.join(out, 'measurements.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(
  JSON.stringify({
    views: report.captures.length,
    assertions: report.assertions,
    failures: report.failures,
  }),
);
if (!measureOnly && report.failures.length) process.exitCode = 1;
