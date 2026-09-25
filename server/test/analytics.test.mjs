import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildStats, extractEditOperations, parsePatch, priceSession } from '../analytics.mjs';

const pricing = JSON.parse(fs.readFileSync(new URL('../pricing.json', import.meta.url), 'utf8'));

function makeSession(overrides = {}) {
  return {
    id: overrides.id ?? 'session-1',
    source: overrides.source ?? 'codex',
    agent: 'test',
    label: overrides.label ?? 'test session',
    model: overrides.model ?? 'gpt-5.3-codex',
    startedAt: overrides.startedAt ?? '2026-07-18T10:00:00.000Z',
    endedAt: overrides.endedAt ?? '2026-07-18T10:00:10.000Z',
    parent: null,
    children: [],
    events: overrides.events ?? [],
    usageEvents: overrides.usageEvents ?? [],
    limitSnapshots: overrides.limitSnapshots ?? [],
    stats: {
      tokensIn: 1_000_000,
      tokensOut: 100_000,
      tokensCacheRead: 400_000,
      tokensCacheWrite: 0,
      messages: 2,
      errors: 0,
      toolCounts: {},
      ...overrides.stats,
    },
  };
}

const tool = (name, args, ts = '2026-07-18T10:00:03.000Z', extra = {}) => ({
  kind: 'tool', ts, tool: { name, args, result: 'ok', resultTs: '2026-07-18T10:00:05.000Z', isError: false, ...extra },
});

test('parsePatch returns a delta for every file in an apply_patch payload', () => {
  const result = parsePatch(`*** Begin Patch
*** Update File: src/a.js
@@
-old
+new
+another
*** Add File: src/b.js
+one
+two
*** End Patch`);
  assert.deepEqual(result, [
    { path: 'src/a.js', additions: 2, deletions: 1 },
    { path: 'src/b.js', additions: 2, deletions: 0 },
  ]);
});

test('extractEditOperations understands Claude Edit and embedded Codex patches', () => {
  assert.deepEqual(extractEditOperations(tool('Edit', {
    file_path: 'src/a.js', old_string: 'one\ntwo', new_string: 'one\nthree\nfour',
  })), [{ path: 'src/a.js', additions: 3, deletions: 2 }]);

  const wrapped = tool('exec', { input: 'await tools.apply_patch(`*** Begin Patch\\n*** Update File: src/b.js\\n@@\\n-old\\n+new\\n*** End Patch`)' });
  assert.deepEqual(extractEditOperations(wrapped), [{ path: 'src/b.js', additions: 1, deletions: 1 }]);

  const multilineWrapper = tool('exec', { input: 'const patch = "*** Begin Patch\\n*** Update File: src/c.js\\n@@\\n-before\\n+after\\n*** End Patch";\ntext(await tools.apply_patch(patch));' });
  assert.deepEqual(extractEditOperations(multilineWrapper), [{ path: 'src/c.js', additions: 1, deletions: 1 }]);

  const outerPatch = `*** Begin Patch
*** Add File: test/fixture.js
+const nested = '*** Begin Patch\\n*** Update File: fake.js\\n@@\\n-old\\n+new\\n*** End Patch';
*** End Patch`;
  const nestedFixture = tool('exec', { input: `const patch = ${JSON.stringify(outerPatch)};\ntext(await tools.apply_patch(patch));` });
  assert.deepEqual(extractEditOperations(nestedFixture), [{ path: 'test/fixture.js', additions: 1, deletions: 0 }]);
});

test('priceSession applies fresh input, cache, and output rates separately', () => {
  const priced = priceSession(makeSession(), pricing);
  // 600k fresh * $1.75 + 400k cache * $0.175 + 100k output * $14
  assert.equal(priced.total, 2.52);
  assert.equal(priced.rate.id, 'gpt-5.3-codex');
});

test('buildStats derives impact, churn, corrections, rework, latency, and abandonment', () => {
  const first = makeSession({
    id: 'first',
    events: [
      { kind: 'user', ts: '2026-07-18T10:00:00.000Z', text: 'Build it' },
      tool('Edit', { file_path: 'src/a.js', old_string: 'old', new_string: 'new\nline' }),
      { kind: 'user', ts: '2026-07-18T10:00:06.000Z', text: "No, that's wrong — keep the old export." },
      tool('Edit', { file_path: 'src/a.js', old_string: 'new', new_string: 'fixed' }, '2026-07-18T10:00:07.000Z'),
      { kind: 'assistant', ts: '2026-07-18T10:00:10.000Z', text: 'Done' },
    ],
  });
  const second = makeSession({
    id: 'second',
    source: 'claude-code',
    model: 'claude-opus-4-8',
    events: [
      { kind: 'user', ts: '2026-07-18T11:00:00.000Z', text: 'Adjust it' },
      tool('Write', { path: 'src/a.js', content: 'replacement\ncontent' }, '2026-07-18T11:00:04.000Z'),
    ],
  });
  const stats = buildStats([first, second], { days: 2, pricing });

  assert.equal(stats.totals.edits, 3);
  assert.equal(stats.totals.filesTouched, 1);
  assert.equal(stats.workflow.reworkLoops, 1);
  assert.equal(stats.workflow.corrections, 1);
  assert.equal(stats.workflow.abandoned, 1);
  assert.equal(stats.workflow.medianTimeToFirstEditMs, 3500);
  assert.equal(stats.impact.files[0].sessions, 2);
  assert.equal(stats.impact.files[0].churn, 2);
  assert.equal(stats.scoreboard.length, 2);
  assert.equal(stats.scoreboard.find((r) => r.source === 'codex').medianToolLatencyMs, 2000);
});

test('unknown models stay explicitly unpriced', () => {
  const stats = buildStats([makeSession({ model: 'vendor-mystery-9' })], { days: 1, pricing });
  assert.equal(stats.cost.pricedSessions, 0);
  assert.equal(stats.cost.unpricedSessions, 1);
  assert.equal(stats.cost.sessions[0].apiCost, null);
});

test('usage events aggregate by source, provider, model, and event time', () => {
  const codex = makeSession({
    id: 'codex-events',
    usageEvents: [
      {
        ts: '2026-07-18T11:55:00.000Z', provider: 'openai', model: 'gpt-5.3-codex',
        tokensIn: 100, tokensOut: 20, tokensReasoning: 5, tokensCacheRead: 30, tokensCacheWrite: 10,
      },
      {
        ts: '2026-07-18T11:59:00.000Z', provider: 'openai', model: 'gpt-5.3-codex',
        tokensIn: 50, tokensOut: 10, tokensReasoning: 0, tokensCacheRead: 0, tokensCacheWrite: 0,
        costUsd: 0.25, costOrigin: 'reported',
      },
    ],
  });
  const opencode = makeSession({
    id: 'opencode-events',
    source: 'opencode',
    usageEvents: [
      {
        ts: '2026-07-18T11:30:00.000Z', provider: 'openai', model: 'gpt-5.3-codex',
        tokensIn: 200, tokensOut: 20, tokensReasoning: 10, tokensCacheRead: 40, tokensCacheWrite: 5,
        costUsd: 0.5, costOrigin: 'reported',
      },
      {
        ts: '2026-07-18T10:00:00.000Z', provider: 'local', model: 'mystery-model',
        tokensIn: 10, tokensOut: 1, tokensReasoning: 0, tokensCacheRead: 0, tokensCacheWrite: 0,
      },
    ],
  });

  const stats = buildStats([codex, opencode], {
    days: 7,
    pricing,
    now: '2026-07-18T12:00:00.000Z',
  });

  assert.deepEqual(stats.usage.tokens, {
    input: 360, output: 51, reasoning: 15, cacheRead: 70, cacheWrite: 15, total: 511,
  });
  assert.equal(stats.usage.eventCount, 4);
  assert.equal(stats.usage.cost.reportedUsd, 0.75);
  assert.equal(stats.usage.cost.estimatedUsd, 0.00054775);
  assert.equal(stats.usage.cost.pricedEvents, 3);
  assert.equal(stats.usage.cost.unpricedEvents, 1);
  assert.equal(stats.usage.cost.coverage, 0.75);
  assert.equal(stats.usage.cost.provenance, 'mixed');

  assert.equal(stats.models.length, 3);
  const codexModel = stats.models.find((row) => row.source === 'codex' && row.provider === 'openai');
  assert.equal(codexModel.eventCount, 2);
  assert.equal(codexModel.tokens.total, 225);
  assert.equal(codexModel.cost.provenance, 'mixed');
  const unknown = stats.models.find((row) => row.model === 'mystery-model');
  assert.equal(unknown.cost.usd, null);
  assert.equal(unknown.cost.provenance, 'unpriced');
  assert.equal(unknown.apiCost, 0);

  assert.equal(stats.burn.tenMinutes.tokens, 225);
  assert.equal(stats.burn.tenMinutes.tokensPerMinute, 22.5);
  assert.equal(stats.burn.tenMinutes.eventCount, 2);
  assert.equal(stats.burn.oneHour.tokens, 500);
  assert.equal(stats.burn.oneHour.tokensPerHour, 500);
  assert.equal(stats.burn.oneHour.eventCount, 3);
  assert.equal(stats.burn.sevenDays.tokens, 511);
  assert.equal(stats.burn.sevenDays.averageTokensPerDay, 73);

  const eventDay = stats.perDay.find((row) => row.date === '2026-07-18');
  assert.equal(eventDay.tokensIn, 445);
  assert.equal(eventDay.tokensOut, 66);
});

test('legacy sessions use a non-overlapping synthetic usage event', () => {
  const stats = buildStats([makeSession({
    stats: { tokensIn: 1_000, tokensOut: 200, tokensCacheRead: 300, tokensCacheWrite: 100 },
  })], {
    days: 1,
    pricing,
    now: '2026-07-18T12:00:00.000Z',
  });

  assert.deepEqual(stats.usage.tokens, {
    input: 600, output: 200, reasoning: 0, cacheRead: 300, cacheWrite: 100, total: 1_200,
  });
  assert.equal(stats.usage.eventCount, 1);
  assert.equal(stats.totals.tokensIn, 1_000);
  assert.equal(stats.models[0].sessions, 1);
  assert.equal(stats.models[0].cost.provenance, 'estimated');
});

test('limits expose newest snapshot per source, provider, and limit with full history', () => {
  const stats = buildStats([makeSession({
    limitSnapshots: [
      { ts: '2026-07-18T10:00:00.000Z', provider: 'openai', limitId: 'primary', label: 'Five hour', usedPercent: 20, windowMinutes: 300, resetsAt: '2026-07-18T13:00:00.000Z', planType: 'plus' },
      { ts: '2026-07-18T11:00:00.000Z', provider: 'openai', limitId: 'primary', label: 'Five hour', usedPercent: 60, windowMinutes: 300, resetsAt: '2026-07-18T13:00:00.000Z', planType: 'plus' },
      { ts: '2026-07-18T10:30:00.000Z', provider: 'openai', limitId: 'secondary', label: 'Weekly', usedPercent: 10, windowMinutes: 10_080, resetsAt: '2026-07-25T00:00:00.000Z', planType: 'plus' },
    ],
  })], { days: 1, pricing, now: '2026-07-18T12:00:00.000Z' });

  assert.equal(stats.limits.history.length, 3);
  assert.equal(stats.limits.history[0].ts, '2026-07-18T11:00:00.000Z');
  assert.equal(stats.limits.latest.length, 2);
  const primary = stats.limits.latest.find((row) => row.limitId === 'primary');
  assert.equal(primary.usedPercent, 60);
  assert.equal(primary.remainingPercent, 40);
  assert.equal(primary.resetsAt, '2026-07-18T13:00:00.000Z');
});

test('daily model series distinguish no usage, unpriced usage, partial prices, and real zero cost', () => {
  const event = (date, model, costUsd) => ({
    ts: `${date}T10:00:00.000Z`, provider: 'fixture', model,
    tokensIn: 10, tokensOut: 2, tokensReasoning: 0, tokensCacheRead: 0, tokensCacheWrite: 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  });
  const stats = buildStats([makeSession({ usageEvents: [
    event('2026-07-16', 'unpriced-fixture'),
    event('2026-07-17', 'partly-reported-fixture', 0.5),
    event('2026-07-17', 'partly-reported-fixture'),
    event('2026-07-18', 'partly-reported-fixture', 0),
  ] })], { days: 4, now: '2026-07-18T12:00:00.000Z' });
  assert.equal(stats.perDay.length, 4);
  assert.deepEqual(stats.perDay.map((day) => day.cost.usd), [0, null, 0.5, 0]);
  assert.deepEqual(stats.perDay.map((day) => day.cost.coverage), [null, 0, 0.5, 1]);
  assert.deepEqual(stats.perDay.map((day) => day.eventCount), [0, 1, 2, 1]);
  assert.deepEqual(stats.perDay.map((day) => day.cost.unpricedEvents), [0, 1, 1, 0]);
  assert.equal(stats.perDay[0].cost.provenance, 'no-usage');
  assert.equal(stats.perDay[2].tokens.total, 24);
  assert.equal(stats.perDay[2].usageSessionCount, 1);
  const model = stats.models.find((row) => row.model === 'partly-reported-fixture');
  assert.equal(model.days.length, 4);
  assert.deepEqual(model.days.map((day) => day.tokens.total), [0, 0, 24, 12]);
  assert.deepEqual(model.days.map((day) => day.cost.usd), [0, 0, 0.5, 0]);
  assert.deepEqual(model.days.map((day) => day.cost.coverage), [null, null, 0.5, 1]);
  assert.equal(model.days.reduce((total, day) => total + day.tokens.total, 0), model.tokens.total);
  assert.equal(model.days.reduce((total, day) => total + (day.cost.usd ?? 0), 0), model.cost.usd);
  for (const day of stats.perDay) {
    assert.equal(stats.models.reduce((total, row) => total + row.days.find((entry) => entry.date === day.date).tokens.total, 0), day.tokens.total);
    assert.equal(stats.models.reduce((total, row) => total + (row.days.find((entry) => entry.date === day.date).cost.usd ?? 0), 0), day.apiCost);
  }
});
