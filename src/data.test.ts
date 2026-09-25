import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDashboard,
  money,
  compact,
  number,
  shortDate,
  localDate,
  cacheReuse,
  costStatus,
  costText,
  dashboardCSV,
  sourceHasIssues,
  sourceLabel,
} from './data.ts';

test('missing metrics stay unknown, while real zero values remain zero', () => {
  const empty = normalizeDashboard(null);
  assert.ok(Object.values(empty.totals).every((value) => value === null));
  assert.deepEqual(empty.days, []);
  const zero = normalizeDashboard({
    stats: {
      usage: {
        eventCount: 0,
        tokens: { total: 0 },
        cost: { usd: 0, coverage: 1, unpricedEvents: 0 },
      },
      totals: { sessions: 0, toolCalls: 0, errors: 0 },
      perDay: [
        {
          date: '2026-09-24',
          tokensIn: 0,
          tokensOut: 0,
          apiCost: 0,
          sessions: 0,
        },
      ],
    },
  });
  assert.equal(zero.totals.cost, 0);
  assert.equal(zero.totals.tokens, 0);
  assert.equal(zero.totals.sessions, 0);
  assert.deepEqual(zero.days[0], {
    date: '2026-09-24',
    tokens: 0,
    cost: 0,
    sessions: 0,
    events: null,
    unpricedEvents: null,
    coverage: null,
  });
});

test('malformed numeric fields and non-array records remain unknown or empty', () => {
  const result = normalizeDashboard({
    stats: {
      usage: {
        eventCount: '12',
        tokens: { total: Infinity, input: '100', output: NaN, cacheRead: 0 },
        cost: { usd: '5.00', coverage: Infinity },
      },
      perDay: 'unavailable',
      models: {},
      limits: { latest: false },
    },
    state: { sessions: {} },
    sourceStatus: [{ source: 'codex', available: 'true', files: '3', issues: false }],
  });
  assert.equal(result.totals.cost, null);
  assert.equal(result.totals.costCoverage, null);
  assert.equal(result.totals.events, null);
  assert.equal(result.totals.tokens, null);
  assert.equal(result.totals.input, null);
  assert.equal(result.totals.output, null);
  assert.equal(result.totals.cacheRead, 0);
  assert.deepEqual(result.days, []);
  assert.deepEqual(result.models, []);
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.limits, []);
  assert.equal(result.sources[0].available, null);
  assert.equal(result.sources[0].files, null);
  assert.deepEqual(result.sources[0].issues, []);
});

test('uses authoritative totals and normalized costs without double-counting cached tokens', () => {
  const raw = {
    generatedAt: '2026-09-24T12:00:00.000Z',
    stats: {
      usage: {
        eventCount: 4,
        tokens: {
          total: 177,
          input: 100,
          output: 20,
          reasoning: 7,
          cacheRead: 40,
          cacheWrite: 10,
        },
        cost: {
          usd: 2.5,
          reportedUsd: 1,
          estimatedUsd: 1.5,
          coverage: 0.75,
          unpricedEvents: 1,
        },
      },
      totals: { sessions: 2, toolCalls: 3, errors: 1 },
      perDay: [
        {
          date: '2026-09-24',
          tokensIn: 150,
          tokensOut: 27,
          tokensCache: 40,
          tokensCacheWrite: 10,
          apiCost: 2.5,
          sessions: 2,
        },
      ],
      models: [
        {
          source: 'codex',
          provider: 'openai',
          model: 'example-model',
          tokens: { total: 177, input: 100, output: 20, cacheRead: 40 },
          cost: { usd: null, coverage: 0 },
          apiCost: 0,
          sessions: 2,
          eventCount: 4,
        },
      ],
      cost: { total: 999, sessions: [{ id: 's1', apiCost: 2.5 }] },
      limits: {
        latest: [
          {
            source: 'codex',
            label: 'Primary',
            usedPercent: 0,
            remainingPercent: 100,
            windowMinutes: 300,
          },
        ],
      },
    },
    state: {
      sessions: [
        {
          id: 's1',
          source: 'codex',
          stats: {
            tokensIn: 150,
            tokensOut: 27,
            tokensCacheRead: 40,
            tokensCacheWrite: 10,
            toolCounts: { read: 2, edit: 1 },
            errors: 1,
          },
          intelligence: { apiCost: 999 },
        },
      ],
    },
    sourceStatus: [
      {
        source: 'codex',
        available: true,
        files: 2,
        sessions: 2,
        warning: null,
      },
    ],
  };
  const result = normalizeDashboard(raw);
  assert.equal(result.totals.cost, 2.5);
  assert.equal(result.totals.tokens, 177);
  assert.equal(result.days[0].tokens, 177);
  assert.equal(result.sessions[0].tokens, 177);
  assert.equal(result.sessions[0].cost, 2.5);
  assert.equal(result.sessions[0].toolCalls, 3);
  assert.equal(result.models[0].cost, null);
  assert.equal(result.models[0].id, 'codex::openai::example-model');
  assert.equal(result.limits[0].usedPercent, 0);
  assert.equal(result.sources[0].available, true);
});

test('unpriced active days are unknown, not free, and missing session cost has no legacy fallback', () => {
  const result = normalizeDashboard({
    stats: {
      usage: { cost: { usd: null, unpricedEvents: 1, provenance: 'unpriced' } },
      perDay: [
        { tokensIn: 10, tokensOut: 0, apiCost: 0 },
        { tokensIn: 0, tokensOut: 0, apiCost: 0 },
      ],
    },
    state: { sessions: [{ id: 's1', intelligence: { apiCost: 0 } }] },
  });
  assert.equal(result.days[0].cost, null);
  assert.equal(result.days[1].cost, 0);
  assert.equal(result.sessions[0].cost, null);
  assert.equal(result.sessions[0].tokens, null);
});

test('formatters handle unknown, zero, and valid numbers and dates', () => {
  for (const value of [null, undefined, NaN, Infinity, '', '123']) {
    assert.equal(money(value), '—');
    assert.equal(number(value), '—');
    assert.equal(compact(value), '—');
  }
  assert.equal(money(0), '$0.00');
  assert.equal(money(12.5), '$12.50');
  assert.equal(number(1234), '1,234');
  assert.equal(compact(1500000), '1.5M');
  assert.equal(shortDate('2026-09-24'), 'Sep 24');
  assert.equal(shortDate(null), '—');
  assert.equal(shortDate('invalid'), '—');
});

test('daily coverage preserves partial priced subtotals, unknown cost, and authoritative free usage', () => {
  const days = [
    {
      date: '2026-09-21',
      tokens: { total: 0 },
      eventCount: 0,
      usageSessionCount: 0,
      cost: { usd: 0, coverage: null, unpricedEvents: 0 },
    },
    {
      date: '2026-09-22',
      tokens: { total: 100 },
      eventCount: 1,
      usageSessionCount: 1,
      cost: { usd: null, coverage: 0, unpricedEvents: 1 },
    },
    {
      date: '2026-09-23',
      tokens: { total: 200 },
      eventCount: 2,
      usageSessionCount: 1,
      cost: { usd: 0.5, coverage: 0.5, unpricedEvents: 1 },
    },
    {
      date: '2026-09-24',
      tokens: { total: 100 },
      eventCount: 1,
      usageSessionCount: 1,
      cost: { usd: 0, coverage: 1, unpricedEvents: 0 },
    },
  ];
  const result = normalizeDashboard({
    stats: {
      usage: { cost: { usd: 0.5, unpricedEvents: 2, coverage: 0.5 } },
      perDay: days,
      models: [
        {
          source: 'codex',
          provider: 'openai',
          model: 'gpt-6-astra',
          name: 'gpt-6-astra',
          tokens: { total: 400, reasoning: 20, cacheWrite: 0 },
          cost: { usd: 0.5, coverage: 0.5, unpricedEvents: 2 },
          days,
        },
      ],
    },
  });
  assert.deepEqual(
    result.days.map((day) => day.cost),
    [0, null, 0.5, 0],
  );
  assert.deepEqual(
    result.days.map((day) => day.coverage),
    [null, 0, 0.5, 1],
  );
  assert.deepEqual(
    result.days.map((day) => day.events),
    [0, 1, 2, 1],
  );
  assert.deepEqual(
    result.days.map((day) => day.unpricedEvents),
    [0, 1, 1, 0],
  );
  assert.deepEqual(result.models[0].days, result.days);
  assert.equal(result.models[0].model, 'gpt-6-astra');
  assert.equal(result.models[0].name, 'gpt-6-astra');
  assert.equal(result.models[0].reasoning, 20);
  assert.equal(result.models[0].cacheWrite, 0);
  assert.equal(result.models[0].unpricedEvents, 2);
});

test('pricing assumptions and per-model context counts remain attached to estimates', () => {
  const rate = {
    input: 4,
    cacheRead: 0.4,
    cacheWrite: 5,
    output: 20,
    serviceTier: 'standard',
    verifiedAt: '2026-09-24',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
    longContext: {
      thresholdInputTokens: 272000,
      input: 8,
      cacheRead: 0.8,
      cacheWrite: 10,
      output: 30,
    },
  };
  const result = normalizeDashboard({
    stats: {
      pricing: { assumption: 'standard-api-token-rates' },
      usage: {
        cost: { usd: 153.27, longContextEvents: 0, contextUncertainEvents: 0 },
      },
      models: [
        {
          model: 'gpt-5.6-sol',
          rate,
          cost: {
            usd: 153.27,
            longContextEvents: 0,
            contextUncertainEvents: 0,
          },
        },
      ],
    },
  });
  const modelRate = result.models[0].rate;
  assert.ok(result.pricing);
  assert.ok(modelRate?.longContext);
  assert.equal(result.pricing.assumption, 'standard-api-token-rates');
  assert.equal(modelRate.longContext.thresholdInputTokens, 272000);
  assert.equal(modelRate.verifiedAt, '2026-09-24');
  assert.equal(result.models[0].longContextEvents, 0);
  assert.equal(result.totals.contextUncertainEvents, 0);
  assert.equal(normalizeDashboard(null).pricing, null);
});

test('usage-event sessions exclude metadata-only sessions and partial session costs retain coverage', () => {
  const data = normalizeDashboard({
    stats: {
      usage: { sessionCount: 1, eventCount: 2 },
      totals: { sessions: 2 },
      cost: {
        sessions: [
          {
            id: 'active',
            apiCost: 0,
            costCoverage: 0.5,
            pricedEvents: 1,
            unpricedEvents: 1,
            costProvenance: 'reported',
          },
        ],
      },
    },
    state: {
      sessions: [
        { id: 'active', stats: { tokensIn: 100, tokensOut: 20 } },
        { id: 'metadata-only' },
      ],
    },
  });
  assert.equal(data.totals.usageSessions, 1);
  assert.equal(data.totals.sessions, 2);
  assert.equal(data.sessions[0].tokens, 120);
  assert.equal(data.sessions[0].coverage, 0.5);
  assert.equal(data.sessions[0].pricedEvents, 1);
  assert.equal(data.sessions[0].unpricedEvents, 1);
  assert.equal(data.sessions[0].provenance, 'reported');
  assert.equal(costText(data.sessions[0]), '$0.00+');
  assert.equal(costText(data.sessions[1]), '—');
  assert.equal(costStatus({ cost: null, unpricedEvents: 2 }), 'Unpriced');
  assert.equal(costText({ cost: null, unpricedEvents: 2 }), 'Unpriced');
  assert.equal(costStatus({ cost: 0, unpricedEvents: 0 }), 'Priced');
  assert.equal(costStatus({ cost: 1 }), 'Coverage unknown');
  assert.equal(costStatus({ cost: 1, coverage: 0.5 }), 'Partial');
  const csv = dashboardCSV(data, false);
  assert.match(csv, /"cost","costStatus","coverage","unpricedEvents","provenance"/);
  assert.match(csv, /"0","Partial","0.5","1","reported"/);
  const modelCSV = dashboardCSV(
    {
      models: [
        {
          name: '=SUM(A1)',
          cost: null,
          unpricedEvents: 2,
          coverage: 0,
          tokens: 100,
        },
      ],
    },
    true,
  );
  assert.match(modelCSV, /"'=SUM\(A1\)"/);
  assert.match(modelCSV, /"","Unpriced","0","2"/);
  assert.match(modelCSV, /"100"/);
});

test('source scan diagnostics distinguish absent sources, partial scans, failures, and pending writes', () => {
  const data = normalizeDashboard({
    sourceStatus: [
      {
        source: 'missing',
        available: false,
        files: 0,
        scannedFiles: 0,
        warning: 'No source found',
      },
      {
        source: 'partial',
        available: true,
        sessions: 2,
        files: 4,
        scannedFiles: 3,
        failedFiles: 1,
        staleFiles: 1,
        malformedLines: 2,
        oversizedLines: 3,
        pendingLines: 1,
        issues: [
          {
            file: '/local/session.jsonl',
            kind: 'malformed',
            message: 'Invalid records skipped',
            count: 2,
          },
        ],
      },
      {
        source: 'failed',
        available: false,
        files: 1,
        scannedFiles: 0,
        failedFiles: 1,
      },
      {
        source: 'pending',
        available: true,
        files: 1,
        scannedFiles: 1,
        pendingLines: 1,
        issues: [{ kind: 'pending-write', message: 'Write in progress' }],
      },
    ],
  });
  const [missing, partial, failed, pending] = data.sources;
  assert.equal(missing.files, 0);
  assert.equal(missing.failedFiles, null);
  assert.equal(sourceHasIssues(missing), false);
  assert.equal(sourceLabel(missing), 'Not found');
  assert.equal(sourceLabel(partial), 'Partial data');
  assert.equal(partial.scannedFiles, 3);
  assert.equal(partial.staleFiles, 1);
  assert.equal(partial.oversizedLines, 3);
  assert.deepEqual(partial.issues[0], {
    file: '/local/session.jsonl',
    kind: 'malformed',
    message: 'Invalid records skipped',
    count: 2,
  });
  assert.equal(sourceLabel(failed), 'Scan failed');
  assert.equal(sourceHasIssues(pending), false);
  assert.equal(pending.pendingLines, 1);
  assert.equal(sourceLabel({ available: null }), 'Not scanned');
  assert.equal(
    sourceHasIssues({
      available: true,
      warning: 'Some files could not be read',
    }),
    true,
  );
});

test('cache reuse requires a known, nonzero input denominator, excludes output, and preserves real zero', () => {
  assert.equal(cacheReuse({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(cacheReuse({ input: 100, cacheRead: null, cacheWrite: 0 }), null);
  assert.equal(cacheReuse({ input: 100, cacheRead: 0 }), null);
  assert.equal(cacheReuse({ input: 100, cacheRead: 0, cacheWrite: 0 }), 0);
  assert.equal(cacheReuse({ input: 10, cacheRead: 80, cacheWrite: 10, output: 1000 }), 80);
});

test('calendar bucket dates stay UTC while session instants display in the viewer timezone', () => {
  const lateUTC = '2026-09-23T20:00:00.000Z';
  assert.equal(shortDate('2026-09-23'), 'Sep 23');
  assert.equal(localDate(lateUTC, 'Asia/Kolkata'), 'Sep 24');
  assert.equal(localDate(lateUTC, 'America/Los_Angeles'), 'Sep 23');
  assert.equal(localDate(null, 'Asia/Kolkata'), '—');
  assert.equal(localDate('invalid', 'Asia/Kolkata'), '—');
});
