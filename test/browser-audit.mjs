/** Isolated Playwright audit. No production mutations and no user browser profile. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const workspace = path.resolve(import.meta.dirname, '../..');
const snapshotPath = path.resolve(
  flag('--snapshot', path.join(import.meta.dirname, 'fixtures/dashboard.json')),
);
const out = path.resolve(flag('--output', path.join(workspace, '.qa/browser')));
process.env.TMPDIR = path.join(workspace, '.qa-tmp');
if (!process.env.PLAYWRIGHT_MODULE) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(import.meta.dirname, '../.playwright');
}
await fs.mkdir(process.env.TMPDIR, { recursive: true });
const base = flag('--url', 'http://127.0.0.1:4520');
if (!/^http:\/\/(127\.0\.0\.1|localhost):4520$/.test(base))
  throw new Error('Audit only accepts the local MeterOak service on port 4520.');
await fs.mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const snapshotBytes = await fs.readFile(snapshotPath);
const raw = JSON.parse(snapshotBytes);
const money = (v) =>
  typeof v === 'number'
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(v)
    : '—';
const num = (v) =>
  typeof v === 'number'
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v)
    : '—';
const compact = (v) =>
  typeof v === 'number'
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
    : '—';
const norm = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const expectedCost = (c) =>
  c?.usd == null ? '—' : money(c.usd) + (c.unpricedEvents > 0 ? '+' : '');
const clone = (v) => structuredClone(v);
const sourceStats = (s) => (s === 'all' ? raw.stats : raw.sourceStats[s]);
const modelId = (m) => [m.source, m.provider, m.model].map((v) => v ?? '').join('::');
const report = {
  startedAt: new Date().toISOString(),
  snapshot: {
    path: snapshotPath,
    sha256: createHash('sha256').update(snapshotBytes).digest('hex'),
    generatedAt: raw.generatedAt,
    tokens: raw.stats.usage.tokens.total,
    cost: raw.stats.usage.cost.usd,
    events: raw.stats.usage.eventCount,
  },
  engine: 'Playwright Chromium',
  cases: [],
  assertions: 0,
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  coverageLimits: [
    'Chromium only; this does not claim Firefox, WebKit, or Selenium coverage.',
    'Frozen API tests verify rendered behavior against one recorded snapshot, not provider invoices or upstream quota services.',
    'Synthetic fixtures explicitly exercise errors, absent sources, and unknown prices.',
  ],
};
let caseName = '',
  scenario = 'baseline',
  requests = 0;
function eq(a, b, message) {
  report.assertions++;
  assert.deepEqual(a, b, message);
}
function ok(a, message) {
  report.assertions++;
  assert.ok(a, message);
}
function matches(a, re, message) {
  report.assertions++;
  assert.match(a, re, message);
}
const browser = await playwright.chromium.launch({
  headless: true,
  downloadsPath: process.env.TMPDIR,
});
report.browserVersion = browser.version();
const contextOptions = {
  viewport: { width: 1600, height: 1000 },
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
  acceptDownloads: true,
  serviceWorkers: 'block',
  reducedMotion: 'reduce',
};
const context = await browser.newContext(contextOptions);
await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.on('console', (m) => {
  if (m.type() === 'error')
    report.consoleErrors.push({ case: caseName, scenario, message: m.text() });
});
page.on('pageerror', (e) =>
  report.pageErrors.push({ case: caseName, scenario, message: e.stack || e.message }),
);
page.on('requestfailed', (r) =>
  report.requestFailures.push({
    case: caseName,
    scenario,
    url: r.url(),
    error: r.failure()?.errorText,
  }),
);
function fixture() {
  if (scenario === 'partial') {
    const r = clone(raw);
    r.sourceStatus = r.sourceStatus.map((s) =>
      s.source === 'codex'
        ? {
            ...s,
            available: true,
            failedFiles: 1,
            staleFiles: 1,
            malformedLines: 2,
            oversizedLines: 3,
            pendingLines: 1,
            warning: 'Audit fixture: some records could not be read.',
            issues: [
              {
                file: 'audit-example.jsonl',
                kind: 'malformed-record',
                message: 'Audit fixture: 2 malformed records skipped.',
                count: 2,
              },
            ],
          }
        : s,
    );
    return r;
  }
  if (scenario === 'partialsession') {
    const r = clone(raw),
      s = r.stats.cost.sessions[0];
    Object.assign(s, {
      apiCost: 12.34,
      costProvenance: 'estimated',
      costCoverage: 0.5,
      pricedEvents: 1,
      unpricedEvents: 1,
    });
    return r;
  }
  if (scenario === 'missing') {
    const r = clone(raw);
    r.sourceStatus = r.sourceStatus.map((s) => ({
      ...s,
      available: false,
      files: 0,
      scannedFiles: 0,
      sessions: 0,
      failedFiles: 0,
      staleFiles: 0,
      malformedLines: 0,
      oversizedLines: 0,
      pendingLines: 0,
      warning: 'No local data source found',
      issues: [],
    }));
    return r;
  }
  if (scenario === 'unpriced') {
    const r = clone(raw);
    function prices(stats) {
      const unknown = (count = 0) => ({
        usd: count ? null : 0,
        reportedUsd: 0,
        estimatedUsd: 0,
        coverage: count ? 0 : null,
        unpricedEvents: count,
        pricedEvents: 0,
        provenance: 'unpriced',
      });
      stats.usage.cost = unknown(stats.usage.eventCount);
      for (const d of stats.perDay) d.cost = unknown(d.eventCount);
      for (const m of stats.models) {
        m.cost = unknown(m.eventCount);
        for (const d of m.days) d.cost = unknown(d.eventCount);
      }
    }
    prices(r.stats);
    for (const s of Object.values(r.sourceStats)) prices(s);
    return r;
  }
  return raw;
}
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort('blockedbyclient');
  if (url.pathname === '/api/dashboard') {
    requests++;
    if (scenario === 'offline')
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"Intentional audit outage"}',
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fixture()),
    });
  }
  return route.continue();
});
async function text(locator) {
  return norm(await locator.textContent());
}
async function textEq(locator, want, message) {
  for (let i = 0; i < 30; i++) {
    if ((await text(locator)) === norm(want)) break;
    await page.waitForTimeout(80);
  }
  eq(await text(locator), norm(want), message);
}
async function visible(locator) {
  await locator.waitFor({ state: 'visible' });
  ok(await locator.isVisible(), 'Expected visible element');
}
async function navigate(name) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if ((await menu.isVisible()) && !(await page.locator('.sidebar').isVisible())) await menu.click();
  await page
    .locator('.sidebar')
    .getByRole('button', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) })
    .click();
  await textEq(page.locator('h1'), name === 'Overview' ? 'Usage overview' : name);
}
async function baseline() {
  scenario = 'baseline';
  await page.goto(base);
  await visible(page.locator('.stat-card').first());
}
async function setSource(s) {
  await page.getByRole('combobox', { name: 'Usage source', exact: true }).selectOption(s);
}
async function metric(label) {
  return page
    .locator('.stat-card')
    .filter({ has: page.locator('div>span').getByText(label, { exact: true }) })
    .locator(':scope>strong');
}
async function statRow(parent, label) {
  return parent
    .locator('.stat-row')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('strong');
}
async function test(name, fn) {
  caseName = name;
  const start = Date.now();
  try {
    await fn();
    report.cases.push({ name, status: 'passed', durationMs: Date.now() - start });
    console.log('PASS', name);
  } catch (e) {
    const screenshot = path.join(
      out,
      `failure-${String(report.cases.length + 1).padStart(2, '0')}.png`,
    );
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    report.cases.push({
      name,
      status: 'failed',
      durationMs: Date.now() - start,
      error: e.stack || String(e),
      screenshot,
    });
    console.log('FAIL', name, e.message);
    await page.keyboard.press('Escape').catch(() => {});
  }
}
async function assertOverview(stats) {
  const t = stats.usage.tokens,
    c = stats.usage.cost;
  const expected = [
    expectedCost(c),
    compact(t.total),
    num(stats.usage.eventCount),
    [t.input, t.cacheRead, t.cacheWrite].every((v) => typeof v === 'number') &&
    t.input + t.cacheRead + t.cacheWrite > 0
      ? `${((t.cacheRead / (t.input + t.cacheRead + t.cacheWrite)) * 100).toFixed(1)}%`
      : '—',
  ];
  eq(
    (await page.locator('.stat-card>strong').allTextContents()).map(norm),
    expected,
    'Overview values match raw API',
  );
  matches(
    await text(page.locator('.stat-card').nth(2)),
    new RegExp(`Across ${num(stats.usage.sessionCount)} sessions`),
  );
  eq(await page.locator('.token-legend>div').count(), 5);
  const values = [t.input, t.cacheRead, t.output, t.reasoning, t.cacheWrite].map(compact);
  eq(
    (await page.locator('.token-legend strong').allTextContents()).map(norm),
    values,
    'Disjoint token categories match API',
  );
}
try {
  await test('Overview: four KPIs, usage-session count, and all token categories match frozen API', async () => {
    await baseline();
    eq(await page.title(), 'MeterOak');
    await visible(page.getByRole('link', { name: 'MeterOak overview', exact: true }));
    await assertOverview(raw.stats);
    await page.screenshot({ path: path.join(out, 'overview-desktop.png'), fullPage: true });
  });
  await test('Overview model allocation: records, tokens, identity colors, and cost mode', async () => {
    await baseline();
    const all = [...raw.stats.models].sort(
      (a, b) => (b.tokens?.total ?? -1) - (a.tokens?.total ?? -1),
    );
    eq(await page.locator('.cp-model-bar').count(), Math.min(6, all.length));
    eq(
      (await page.locator('.cp-model-value').allTextContents()).map(norm),
      all.slice(0, 6).map((m) => compact(m.tokens?.total)),
    );
    await page
      .locator('.cp-model-controls')
      .getByRole('button', { name: 'Cost', exact: true })
      .click();
    const costs = [...raw.stats.models].sort(
      (a, b) =>
        (b.cost?.usd ?? -1) - (a.cost?.usd ?? -1) ||
        (a.model || a.name).localeCompare(b.model || b.name),
    );
    eq(
      (await page.locator('.cp-model-id').allTextContents()).map(norm),
      costs.slice(0, 6).map((m) => m.model || m.name),
    );
    eq(
      (await page.locator('.cp-model-value').allTextContents()).map(norm),
      costs.slice(0, 6).map((m) => (m.cost?.usd == null ? 'Unpriced' : money(m.cost.usd))),
    );
  });
  await test('Chart: 7/14/30 day token totals and daily table values match API', async () => {
    await baseline();
    for (const count of [7, 14, 30]) {
      await page
        .getByRole('combobox', { name: 'Chart period', exact: true })
        .selectOption(String(count));
      const days = [...raw.stats.perDay].sort((a, b) => a.date.localeCompare(b.date)).slice(-count);
      await textEq(
        page.locator('.chart-filter-row>strong'),
        `${compact(days.reduce((n, d) => n + d.tokens.total, 0))} tokens`,
      );
      eq(await page.locator('.day-target').count(), days.length);
      if (!(await page.locator('.chart-values').evaluate((el) => el.open)))
        await page.locator('.chart-values>summary').click();
      const rows = page.locator('.chart-values tbody tr');
      eq(await rows.count(), days.length);
      for (let i = 0; i < days.length; i++)
        eq(await rows.nth(i).locator('td').nth(1).innerText(), num(days[i].tokens.total));
    }
  });
  await test('Chart: model filter, cost subtotals, unknown-cost marks, and keyboard tooltip', async () => {
    await baseline();
    const model =
      raw.stats.models.find((m) => m.model === 'gpt-6-astra') ||
      raw.stats.models.find((m) => m.tokens.total > 0);
    await page
      .getByRole('combobox', { name: 'Chart model', exact: true })
      .selectOption(modelId(model));
    await page.getByRole('combobox', { name: 'Chart period', exact: true }).selectOption('7');
    const days = [...model.days].sort((a, b) => a.date.localeCompare(b.date)).slice(-7);
    await textEq(
      page.locator('.chart-filter-row>strong'),
      `${compact(days.reduce((n, d) => n + d.tokens.total, 0))} tokens`,
    );
    const ids = await page
      .locator('rect[data-model]')
      .evaluateAll((es) => [...new Set(es.map((e) => e.dataset.model))]);
    eq(ids, [model.model]);
    await page.locator('.chart-actions').getByRole('button', { name: 'Cost', exact: true }).click();
    const total = days.reduce((n, d) => n + (d.cost.usd ?? 0), 0),
      partial = days.some((d) => d.cost.unpricedEvents > 0);
    await textEq(page.locator('.chart-filter-row>strong'), money(total) + (partial ? '+' : ''));
    await page.locator('.day-target').last().focus();
    await visible(page.locator('.daily-tooltip'));
    await page.keyboard.press('Escape');
    eq(await page.locator('.daily-tooltip').count(), 0);
  });
  await test('Models: exact records and every displayed numeric table cell match API', async () => {
    await baseline();
    await navigate('Models');
    const rows = page.locator('.cp-model-table tbody tr');
    eq(await rows.count(), raw.stats.models.length);
    for (const m of raw.stats.models) {
      const row = rows.filter({
        has: page.locator('code').getByText(m.model || m.name, { exact: true }),
      });
      await visible(row);
      const cells = await row.locator('td').allTextContents();
      matches(
        norm(cells[1]),
        new RegExp(compact(m.tokens.total).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      eq(norm(cells[2]), num(m.eventCount));
      eq(norm(cells[3]), num(m.sessions));
      ok(norm(cells[4]).startsWith(m.cost.usd == null ? 'Unpriced' : money(m.cost.usd)));
    }
  });
  await test('Models: search, empty result, clear, and all four sort choices', async () => {
    await baseline();
    await navigate('Models');
    const search = page.getByRole('searchbox', { name: 'Search models by name or exact ID' });
    const m = raw.stats.models[0];
    await search.fill(m.model);
    ok((await page.locator('.cp-model-table tbody tr').count()) > 0);
    await search.fill('audit-nonexistent-model-92851');
    eq(await page.locator('.cp-model-table tbody tr').count(), 0);
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    for (const sort of ['tokens', 'events', 'sessions', 'cost']) {
      await page.getByRole('combobox', { name: 'Sort models' }).selectOption(sort);
      const val = (x) =>
        sort === 'tokens'
          ? x.tokens.total
          : sort === 'events'
            ? x.eventCount
            : sort === 'cost'
              ? x.cost.usd
              : x.sessions;
      const expected = [...raw.stats.models].sort(
        (a, b) =>
          (val(b) ?? -1) - (val(a) ?? -1) || (a.model || a.name).localeCompare(b.model || b.name),
      );
      eq(
        (await page.locator('.cp-model-table tbody code').allTextContents()).map(norm),
        expected.map((x) => x.model || x.name),
      );
    }
  });
  await test('CSV export: downloadable model records include cost status and coverage', async () => {
    await baseline();
    await navigate('Models');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
    const dl = await pending;
    eq(await dl.failure(), null);
    const file = path.join(out, 'models-export.csv');
    await dl.saveAs(file);
    const csv = await fs.readFile(file, 'utf8');
    matches(csv, /"costStatus","coverage","unpricedEvents","provenance"/);
    eq(csv.trim().split('\r\n').length, raw.stats.models.length + 1);
    for (const m of raw.stats.models) {
      const line = csv.split('\r\n').find((s) => s.startsWith(`"${m.model}",`));
      ok(line, 'Export includes each exact model');
      ok(
        line.includes(
          `"${m.cost.usd == null ? 'Unpriced' : m.cost.unpricedEvents > 0 ? 'Partial' : 'Priced'}","${m.cost.coverage}","${m.cost.unpricedEvents}","${m.cost.provenance}"`,
        ),
        'Export preserves coverage and unknown prices',
      );
    }
  });
  await test('Sessions: pagination, search, detail values, local date, and Escape close', async () => {
    await baseline();
    await navigate('Session history');
    const count = raw.state.sessions.length;
    eq(await page.locator('.sessions-panel tbody tr').count(), Math.min(12, count));
    if (count > 12) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      matches(await text(page.locator('.table-footer')), /13–/);
      await page.getByRole('button', { name: 'Previous', exact: true }).click();
    }
    const s = [...raw.state.sessions].sort(
      (a, b) => new Date(b.startedAt) - new Date(a.startedAt),
    )[0];
    await page.getByRole('textbox', { name: 'Search sessions' }).fill(s.id);
    eq(await page.locator('.sessions-panel tbody tr').count(), 1);
    await page.getByRole('button', { name: `View session ${s.id}`, exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Session details' });
    await visible(modal);
    await textEq(await statRow(modal, 'Tokens'), num(s.stats.tokensIn + s.stats.tokensOut));
    const c = raw.stats.cost.sessions.find((c) => c.id === s.id);
    const expected =
      c?.apiCost == null
        ? c?.unpricedEvents > 0
          ? 'Unpriced'
          : '—'
        : money(c.apiCost) + (c.unpricedEvents > 0 ? '+' : '');
    await textEq(await statRow(modal, 'API cost'), expected);
    await textEq(await statRow(modal, 'Unpriced events'), num(c?.unpricedEvents));
    await textEq(
      await statRow(modal, 'Started'),
      new Date(s.startedAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
    await page.keyboard.press('Escape');
    eq(await modal.count(), 0);
  });
  await test('Source filters: Codex and OpenCode totals, empty states, and filter reset', async () => {
    await baseline();
    for (const s of ['codex', 'opencode']) {
      await setSource(s);
      await assertOverview(sourceStats(s));
      if (sourceStats(s).usage.eventCount === 0) {
        await visible(page.getByText('No recorded usage in this period.', { exact: true }));
        await visible(
          page.getByText('Models appear when your local tools record usage.', { exact: true }),
        );
        eq(await page.locator('.stat-card').nth(3).locator(':scope>strong').innerText(), '—');
      }
    }
    await setSource('all');
    await assertOverview(raw.stats);
  });
  await test('Pricing disclosure: saved rate rows, long context rule, and unpriced disclaimer', async () => {
    await baseline();
    await page.locator('.pricing-details>summary').click();
    await visible(page.locator('.pricing-explanation'));
    eq(
      await page.locator('.pricing-explanation tbody tr').count(),
      raw.stats.models.filter((m) => m.rate).length,
    );
    matches(
      await text(page.locator('.pricing-explanation')),
      /Any cost reported by a local source is kept as reported/,
    );
    matches(await text(page.locator('.pricing-explanation')), /not reconstruct past invoices/);
    if (raw.stats.usage.cost.unpricedEvents > 0)
      matches(
        await text(page.locator('.pricing-explanation')),
        new RegExp(
          `${num(raw.stats.usage.cost.unpricedEvents)} events still have no matching price`,
        ),
      );
    const priced = raw.stats.models.filter((m) => m.rate),
      rows = page.locator('.pricing-explanation tbody tr');
    for (let i = 0; i < priced.length; i++) {
      const m = priced[i],
        rate = m.rate,
        cells = await rows.nth(i).locator('td').allTextContents();
      eq(
        cells.slice(0, 4).map(norm),
        [rate.input, rate.cacheRead, rate.cacheWrite, rate.output].map(money),
        'Exact displayed standard rates match saved snapshot',
      );
      if (rate.longContext) {
        const r = rate.longContext,
          rule = await text(page.locator('.pricing-context-rule').filter({ hasText: rate.label }));
        matches(rule, new RegExp(`above ${num(r.thresholdInputTokens)} input tokens`));
        for (const key of ['input', 'cacheRead', 'cacheWrite', 'output'])
          ok(rule.includes(money(r[key])), 'Long context rate is disclosed');
        matches(rule, new RegExp(`${num(m.cost.longContextEvents)} recorded usage events`));
      }
    }
    await page.locator('.pricing-details>summary').click();
    eq(await page.locator('.pricing-explanation').isVisible(), false);
  });
  await test('Budgets: validation, source isolation, warning, persistence, and full cleanup', async () => {
    await baseline();
    const key = 'meteroak.local.budgets.v1';
    const before = await page.evaluate((k) => localStorage.getItem(k), key);
    try {
      await navigate('Budgets');
      await page.getByLabel('30-day target (USD)').fill('0');
      await page.getByRole('button', { name: 'Save target', exact: true }).click();
      await visible(page.getByRole('alert'));
      await page.getByLabel('30-day target (USD)').fill('100');
      await page.getByLabel('Warning threshold (%)').fill('80');
      await page.getByRole('button', { name: 'Save target', exact: true }).click();
      await visible(page.getByText('Cost target saved for this source.', { exact: true }));
      eq(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).all, key), {
        amount: 100,
        threshold: 80,
      });
      await setSource('codex');
      eq(await page.getByLabel('30-day target (USD)').inputValue(), '');
      await setSource('all');
      eq(await page.getByLabel('30-day target (USD)').inputValue(), '100');
      await navigate('Overview');
      if (raw.stats.usage.cost.usd >= 80) await visible(page.locator('.budget-alert'));
      await page.reload();
      await visible(page.locator('.stat-card').first());
      await navigate('Budgets');
      eq(await page.getByLabel('30-day target (USD)').inputValue(), '100');
      await page.getByRole('button', { name: 'Remove target', exact: true }).click();
      eq(await page.getByRole('button', { name: 'Remove target', exact: true }).count(), 0);
    } finally {
      await page.evaluate(
        ({ key, before }) =>
          before === null ? localStorage.removeItem(key) : localStorage.setItem(key, before),
        { key, before },
      );
      eq(await page.evaluate((k) => localStorage.getItem(k), key), before);
    }
  });
  await test('Insights: cache reuse, coverage, reported/estimated split, and model navigation', async () => {
    await baseline();
    await navigate('Insights');
    eq(await page.locator('.card-grid>.panel').count(), 6);
    const panels = page.locator('.card-grid>.panel');
    const panel = (label) =>
      panels.filter({ has: page.getByRole('heading', { name: label, exact: true }) });
    const t = raw.stats.usage.tokens,
      c = raw.stats.usage.cost;
    await textEq(
      panel('Cached input').locator('.metric-value'),
      `${Math.round((t.cacheRead / (t.input + t.cacheRead + t.cacheWrite)) * 100)}%`,
    );
    await textEq(
      panel('Pricing coverage').locator('.metric-value'),
      `${Math.round(c.coverage * 100)}%`,
    );
    await textEq(
      await statRow(panel('What cost includes'), 'Cost reported by tools'),
      money(c.reportedUsd),
    );
    await textEq(
      await statRow(panel('What cost includes'), 'Estimated from model prices'),
      money(c.estimatedUsd),
    );
    await page.getByRole('button', { name: 'Review models', exact: true }).click();
    await textEq(page.locator('h1'), 'Models');
  });
  await test('Connections: scan counts, duplicate counts, recorded limits, and rescan', async () => {
    await baseline();
    await navigate('Connections');
    for (const s of raw.sourceStatus) {
      const name = s.source === 'codex' ? 'Codex' : 'OpenCode';
      const p = page
        .locator('.card-grid>.panel')
        .filter({ has: page.getByRole('heading', { name, exact: true }) });
      await textEq(await statRow(p, 'Sessions found'), num(s.sessions));
      await textEq(
        await statRow(p, 'Files found / scanned'),
        `${num(s.files)} / ${num(s.scannedFiles)}`,
      );
      await textEq(
        await statRow(p, 'Duplicate usage records removed'),
        num(s.duplicateUsageEvents),
      );
    }
    await visible(page.getByRole('heading', { name: 'Recorded usage limits' }));
    const before = requests;
    await page.getByRole('button', { name: 'Scan again', exact: true }).click();
    await page.waitForTimeout(150);
    ok(requests > before, 'Rescan makes a new request');
  });
  await test('Theme: Original and Portfolio preserve chart filters, use correct colors, and persist', async () => {
    await baseline();
    await page.getByRole('combobox', { name: 'Chart period' }).selectOption('7');
    await page.locator('.chart-actions').getByRole('button', { name: 'Cost', exact: true }).click();
    for (const design of ['original', 'portfolio']) {
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(design);
      eq(await page.locator('html').getAttribute('data-design'), design);
      eq(await page.evaluate(() => localStorage.getItem('meteroak.appearance.v1')), design);
      eq(await page.getByRole('combobox', { name: 'Chart period' }).inputValue(), '7');
      eq(
        await page
          .locator('.chart-actions')
          .getByRole('button', { name: 'Cost', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      );
      const color = await page
        .locator('rect[data-model="gpt-6-astra"]')
        .first()
        .evaluate((e) => getComputedStyle(e).fill);
      eq(color, design === 'original' ? 'rgb(101, 86, 219)' : 'rgb(40, 91, 69)');
    }
    await page.getByRole('combobox', { name: 'Appearance' }).selectOption('original');
    await page.reload();
    await visible(page.locator('.stat-card').first());
    eq(await page.getByRole('combobox', { name: 'Appearance' }).inputValue(), 'original');
    await assertOverview(raw.stats);
    await page.getByRole('combobox', { name: 'Appearance' }).selectOption('portfolio');
  });
  await test('Synthetic diagnostics: partial scan banner and bounded issue details', async () => {
    scenario = 'partial';
    await page.goto(base);
    await visible(page.locator('.data-quality-banner'));
    matches(await text(page.locator('.data-quality-banner')), /Totals may be incomplete/);
    await page.getByRole('button', { name: 'Review sources', exact: true }).click();
    await textEq(page.locator('h1'), 'Connections');
    await visible(page.getByText('Malformed lines skipped', { exact: true }));
    await page.locator('.source-issues>summary').first().click();
    await visible(page.getByText('Audit fixture: 2 malformed records skipped.', { exact: true }));
  });
  await test('Synthetic diagnostics: no source is disclosed distinctly from partial data', async () => {
    scenario = 'missing';
    await page.goto(base);
    await visible(page.getByText('No local sources found', { exact: true }));
    matches(
      await text(page.locator('.data-quality-banner')),
      /do not confirm that no usage occurred/,
    );
    ok(
      !(await text(page.locator('.data-quality-banner')).then((s) =>
        s.includes('Totals may be incomplete'),
      )),
    );
  });
  await test('Synthetic pricing: all-unknown cost is Unpriced while tokens remain available', async () => {
    scenario = 'unpriced';
    await page.goto(base);
    await visible(page.locator('.stat-card').first());
    eq(await page.locator('.stat-card>strong').first().innerText(), '—');
    eq(
      await page.locator('.stat-card>strong').nth(1).innerText(),
      compact(raw.stats.usage.tokens.total),
    );
    await page.locator('.chart-actions').getByRole('button', { name: 'Cost', exact: true }).click();
    await textEq(page.locator('.chart-filter-row>strong'), 'Unpriced');
    await visible(page.getByText('No prices available for this usage.', { exact: false }));
    ok((await page.locator('rect[fill="url(#unpriced-hatch)"]').count()) > 0);
  });
  await test('Synthetic partial session: subtotal marker, unpriced details, and CSV status', async () => {
    scenario = 'partialsession';
    await page.goto(base);
    await visible(page.locator('.stat-card').first());
    await navigate('Session history');
    const id = raw.stats.cost.sessions[0].id;
    await page.getByRole('textbox', { name: 'Search sessions' }).fill(id);
    eq(await page.locator('.sessions-panel tbody tr').count(), 1);
    matches(await text(page.locator('.sessions-panel tbody tr')), /\$12\.34\+1 unpriced event/);
    await page.getByRole('button', { name: `View session ${id}`, exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Session details' });
    await textEq(await statRow(modal, 'API cost'), '$12.34+');
    await textEq(await statRow(modal, 'Unpriced events'), '1');
    matches(await text(modal), /unknown cost is excluded from this subtotal/);
    await page.keyboard.press('Escape');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
    const dl = await pending;
    eq(await dl.failure(), null);
    const file = path.join(out, 'sessions-partial-export.csv');
    await dl.saveAs(file);
    const csv = await fs.readFile(file, 'utf8'),
      row = csv.split('\r\n').find((s) => s.startsWith(`"${id}",`));
    ok(row, 'Export contains the modified session');
    ok(
      row.includes('"12.34","Partial","0.5","1","estimated"'),
      'CSV labels the partial subtotal and coverage',
    );
  });
  await test('Reader outage: stale snapshot warning, retry, and recovery', async () => {
    await baseline();
    scenario = 'offline';
    await page.getByRole('button', { name: 'Refresh usage', exact: true }).click();
    await visible(page.getByRole('alert'));
    matches(await text(page.getByRole('alert')), /Showing the last successful snapshot/);
    await assertOverview(raw.stats);
    scenario = 'baseline';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    await assertOverview(raw.stats);
  });
  await test('Initial reader outage: loading error and retry recovery', async () => {
    scenario = 'offline';
    await page.goto(base);
    await visible(page.getByText('Your reader needs attention', { exact: true }));
    await visible(
      page.getByText('Run npm start in the MeterOak folder to start both services.', {
        exact: true,
      }),
    );
    eq(await page.locator('.stat-card').count(), 0);
    scenario = 'baseline';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await visible(page.locator('.stat-card').first());
    await assertOverview(raw.stats);
  });
  for (const design of ['portfolio', 'original'])
    for (const width of [319, 390, 640, 641, 768, 1024, 1600])
      await test(`Responsive ${design} ${width}px: six pages and viewport overflow`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await baseline();
        await page.getByRole('combobox', { name: 'Appearance' }).selectOption(design);
        const problems = [];
        for (const name of [
          'Overview',
          'Models',
          'Session history',
          'Budgets',
          'Insights',
          'Connections',
        ]) {
          await navigate(name);
          const excess = await page.evaluate(() => ({
            document: document.documentElement.scrollWidth - window.innerWidth,
            body: document.body.scrollWidth - window.innerWidth,
          }));
          report.assertions++;
          if (excess.document > 1 || excess.body > 1)
            problems.push({ page: name, kind: 'page-overflow', ...excess });
          const outside = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                'button,select,input,h1,.panel,.stat-card,.appearance-control,.data-quality-banner',
              ),
            ]
              .filter((e) => {
                const s = getComputedStyle(e),
                  r = e.getBoundingClientRect();
                return (
                  s.visibility !== 'hidden' &&
                  s.display !== 'none' &&
                  r.width > 0 &&
                  r.height > 0 &&
                  !e.closest('.table-scroll') &&
                  (r.left < -1 || r.right > innerWidth + 1)
                );
              })
              .map((e) => ({
                tag: e.tagName,
                class: e.className,
                text: e.textContent.trim().slice(0, 65),
                left: e.getBoundingClientRect().left,
                right: e.getBoundingClientRect().right,
              })),
          );
          report.assertions++;
          if (outside.length)
            problems.push({ page: name, kind: 'offscreen-content', elements: outside });
          (report.responsiveViews ??= []).push({ design, width, page: name, excess, outside });
          if (excess.document > 1 || excess.body > 1 || outside.length)
            await page.screenshot({
              path: path.join(
                out,
                `overflow-${design}-${width}-${name.toLowerCase().replaceAll(' ', '-')}.png`,
              ),
              fullPage: true,
            });
        }
        await navigate('Overview');
        if (width === 390)
          await page.screenshot({
            path: path.join(out, `overview-${design}-mobile.png`),
            fullPage: true,
          });
        eq(problems, [], `Responsive ${design} ${width}px defects: ${JSON.stringify(problems)}`);
      });
  await test('Mobile drawer: close button scrim and Escape restore navigation control', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await baseline();
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await visible(page.locator('.sidebar'));
    await page.keyboard.press('Escape');
    eq(await page.locator('.sidebar').isVisible(), false);
    eq(
      await page
        .getByRole('button', { name: 'Open navigation', exact: true })
        .getAttribute('aria-expanded'),
      'false',
    );
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page
      .getByRole('button', { name: 'Close navigation', exact: true })
      .click({ position: { x: 300, y: 100 } });
    eq(await page.locator('.sidebar').isVisible(), false);
  });
  await test('No unexpected browser JavaScript errors across audit', async () => {
    eq(report.pageErrors, []);
    const unexpected = report.consoleErrors.filter(
      (x) => x.scenario !== 'offline' && !x.message.includes('net::ERR_BLOCKED_BY_CLIENT'),
    );
    eq(unexpected, []);
  });
} finally {
  await page.evaluate(() => localStorage.removeItem('meteroak.local.budgets.v1')).catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.summary = {
    passed: report.cases.filter((x) => x.status === 'passed').length,
    failed: report.cases.filter((x) => x.status === 'failed').length,
    cases: report.cases.length,
    assertions: report.assertions,
    apiRequests: requests,
  };
  await context.tracing.stop({ path: path.join(out, 'trace.zip') }).catch(() => {});
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const lines = [
    '# MeterOak isolated browser audit',
    '',
    `Snapshot: ${raw.generatedAt}`,
    `Snapshot SHA256: ${report.snapshot.sha256}`,
    `Browser: ${report.engine} ${report.browserVersion}`,
    '',
    `${report.summary.passed}/${report.summary.cases} cases passed; ${report.summary.failed} failed. ${report.assertions} assertions attempted.`,
    ...report.coverageLimits.map((s) => `- ${s}`),
    '',
    '| Test | Result |',
    '| --- | --- |',
    ...report.cases.map((c) => `| ${c.name} | ${c.status} |`),
    '',
    ...report.cases
      .filter((c) => c.status === 'failed')
      .flatMap((c) => [`## ${c.name}`, '', '```', c.error, '```', '']),
  ];
  await fs.writeFile(path.join(out, 'report.md'), lines.join('\n'));
  await browser.close();
  console.log(JSON.stringify(report.summary));
}
if (report.summary.failed) process.exitCode = 1;
