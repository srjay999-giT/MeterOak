import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarWindow, strictWindowSessions } from '../window.mjs';
import { buildStats } from '../analytics.mjs';

const now = new Date(2026, 8, 24, 12, 0, 0).getTime();
const bounds = calendarWindow(30, now);
const iso = (value) => new Date(value).toISOString();
const usage = (ts, amount = 100, extra = {}) => ({
  ts: iso(ts), provider: 'openai', model: 'fixture-model',
  tokensIn: amount, tokensOut: 20, tokensReasoning: 5,
  tokensCacheRead: 30, tokensCacheWrite: 10, costUsd: 1, ...extra,
});
const tool = (ts, extra = {}) => ({
  kind: 'tool', ts: iso(ts),
  tool: { id: 'call-1', name: 'read', args: {}, result: null, resultTs: null, ...extra },
});
const session = (extra = {}) => ({
  id: 'task', source: 'codex', model: 'fixture-model', label: 'Synthetic task',
  file: '/fixture/a.jsonl', parent: null, children: [], spawnCandidates: [],
  startedAt: iso(bounds.from - 1000), endedAt: iso(now),
  usageEvents: [], events: [], limitSnapshots: [],
  stats: { tokensIn: 999999, tokensOut: 99999, tokensCacheRead: 100, tokensCacheWrite: 100, toolCounts: {}, errors: 0, messages: 99 },
  ...extra,
});

test('strict window includes exact local calendar start and now, excludes old/future/untimed usage', () => {
  assert.equal(new Date(bounds.from).getHours(), 0);
  assert.equal(new Date(bounds.from).getDate(), 26);
  const original = session({
    usageEvents: [usage(bounds.from - 1), usage(bounds.from), usage(now), usage(now + 1), { ...usage(now), ts: null }],
    events: [tool(bounds.from - 1), tool(now)],
    limitSnapshots: [{ ts: iso(bounds.from - 1) }, { ts: iso(now), usedPercent: 20 }],
  });
  const unchanged = structuredClone(original);
  const [filtered] = strictWindowSessions([original], { days: 30, now });
  assert.equal(filtered.usageEvents.length, 2);
  assert.equal(filtered.events.length, 1);
  assert.equal(filtered.limitSnapshots.length, 1);
  assert.equal(filtered.stats.tokensIn, 280);
  assert.equal(filtered.stats.tokensOut, 50);
  assert.equal(filtered.stats.tokensCacheRead, 60);
  assert.equal(filtered.stats.toolCounts.read, 1);
  assert.deepEqual(original, unchanged);
  const stats = buildStats([filtered], { days: 30, now });
  assert.equal(stats.usage.tokens.total, 330);
  assert.equal(stats.usage.cost.usd, 2);
  assert.equal(stats.perDay.reduce((total, day) => total + day.tokensIn + day.tokensOut, 0), 330);
  assert.equal(stats.perDay.reduce((total, day) => total + day.apiCost, 0), 2);
  assert.equal(stats.models[0].cost.usd, 2);
  assert.equal(stats.cost.sessions[0].apiCost, 2);
});

test('overlapping logs merge logical identities and shared records without losing distinct events', () => {
  const first = usage(now - 3000);
  const second = usage(now - 2000, 200);
  const third = usage(now - 1000, 300);
  const call = tool(now - 1500);
  const parts = [
    session({ usageEvents: [first, second], events: [call] }),
    session({ file: '/fixture/b.jsonl', usageEvents: [structuredClone(first), third], events: [tool(now - 1500, { result: 'ok', resultTs: iso(now - 1000) })] }),
  ];
  const original = structuredClone(parts);
  const diagnostics = {};
  const merged = strictWindowSessions(parts, { days: 30, now, diagnostics });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'codex:task');
  assert.equal(merged[0].usageEvents.length, 3);
  assert.equal(merged[0].events.length, 1);
  assert.equal(merged[0].events[0].tool.result, 'ok');
  assert.equal(merged[0].stats.toolCounts.read, 1);
  assert.deepEqual(parts, original);
  const stats = buildStats(merged, { days: 30, now });
  assert.equal(stats.usage.cost.usd, 3);
  assert.equal(stats.usage.tokens.total, 795);
  assert.equal(stats.totals.sessions, 1);
  assert.equal(stats.perDay.reduce((total, day) => total + day.apiCost, 0), stats.usage.cost.usd);
  assert.equal(diagnostics.duplicateSessionFiles, 1);
  assert.equal(diagnostics.duplicateUsageEvents, 1);
  assert.equal(diagnostics.duplicateActivityEvents, 1);
  assert.equal(diagnostics.duplicateLimitSnapshots, 0);
  assert.deepEqual(diagnostics.bySource.codex, {
    duplicateSessionFiles: 1, duplicateUsageEvents: 1, duplicateActivityEvents: 1, duplicateLimitSnapshots: 0,
  });
});

test('dedup preserves repeated same-signature events within a stream and separates sources', () => {
  const repeated = usage(now - 1000);
  const merged = strictWindowSessions([
    session({ usageEvents: [repeated, structuredClone(repeated)] }),
    session({ file: '/fixture/b.jsonl', usageEvents: [structuredClone(repeated)] }),
    session({ source: 'opencode', usageEvents: [structuredClone(repeated)] }),
  ], { days: 30, now });
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((row) => row.id), ['codex:task', 'opencode:task']);
  assert.equal(merged[0].usageEvents.length, 2);
  assert.equal(buildStats(merged, { days: 30, now }).usage.eventCount, 3);
});

test('a recent tool or limit does not turn expired usage into a synthetic zero usage event', () => {
  const filtered = strictWindowSessions([session({
    usageEvents: [usage(bounds.from - 1)], events: [tool(now)],
  })], { days: 30, now });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].stats.tokensIn, 0);
  const stats = buildStats(filtered, { days: 30, now });
  assert.equal(stats.usage.eventCount, 0);
  assert.equal(stats.usage.tokens.total, 0);
  assert.equal(stats.usage.cost.unpricedEvents, 0);
  assert.equal(stats.usage.cost.usd, null);
  assert.equal(stats.totals.toolCalls, 1);
  assert.equal(strictWindowSessions([session({ usageEvents: [usage(bounds.from - 1)] })], { days: 30, now }).length, 0);
  // Existing non-strict analytics retain their historical fallback behavior.
  assert.equal(buildStats([session()], { days: 30, now }).usage.eventCount, 1);
});

test('duplicate audit uses maximum multiplicity and reports confirmed removals per source', () => {
  const repeated = usage(now - 1000);
  const limit = { ts: iso(now), limitId: 'codex:primary', usedPercent: 50, windowMinutes: 300, resetsAt: iso(now + 1000) };
  const diagnostics = { linesRead: 99 };
  const result = strictWindowSessions([
    session({ usageEvents: [repeated, structuredClone(repeated)], limitSnapshots: [limit] }),
    session({ file: '/fixture/b.jsonl', usageEvents: [structuredClone(repeated)], limitSnapshots: [structuredClone(limit)] }),
    session({ file: '/fixture/c.jsonl', usageEvents: [structuredClone(repeated), structuredClone(repeated), structuredClone(repeated)] }),
    session({ source: 'opencode', usageEvents: [structuredClone(repeated), structuredClone(repeated)] }),
    session({ source: 'opencode', file: '/fixture/opencode-copy.db', usageEvents: [structuredClone(repeated)] }),
  ], { days: 30, now, diagnostics });
  assert.equal(result[0].usageEvents.length, 3);
  assert.equal(result[1].usageEvents.length, 2);
  assert.equal(diagnostics.linesRead, 99);
  assert.equal(diagnostics.duplicateSessionFiles, 3);
  assert.equal(diagnostics.duplicateUsageEvents, 4);
  assert.equal(diagnostics.duplicateLimitSnapshots, 1);
  assert.equal(diagnostics.bySource.codex.duplicateUsageEvents, 3);
  assert.equal(diagnostics.bySource.opencode.duplicateUsageEvents, 1);
  assert.equal(diagnostics.bySource.codex.duplicateSessionFiles, 2);
  assert.equal(diagnostics.bySource.opencode.duplicateSessionFiles, 1);
});

test('equal-sized requests keep independent request IDs, timestamps, and model switches', () => {
  const first = usage(now - 1000, 100, { requestId: 'request-a', model: 'gpt-6-astra' });
  const otherRequest = { ...first, requestId: 'request-b' };
  const otherTime = { ...first, ts: iso(now - 999) };
  const otherModel = { ...first, model: 'gpt-5.6-sol' };
  const diagnostics = {};
  const [result] = strictWindowSessions([
    session({ usageEvents: [first, otherTime, otherModel] }),
    session({ file: '/fixture/b.jsonl', usageEvents: [structuredClone(first), otherRequest, structuredClone(otherModel)] }),
  ], { days: 30, now, diagnostics });
  assert.equal(result.usageEvents.length, 4);
  assert.deepEqual(new Set(result.usageEvents.map((event) => JSON.stringify([event.requestId, event.ts, event.model]))), new Set([first, otherRequest, otherTime, otherModel].map((event) => JSON.stringify([event.requestId, event.ts, event.model]))));
  assert.equal(diagnostics.duplicateUsageEvents, 2);
  assert.equal(buildStats([result], { days: 30, now }).usage.tokens.total, 660);
});

test('same-time equal usage and privacy-redacted messages with distinct IDs are not duplicates', () => {
  const first = usage(now - 1000, 100, { messageId: 'message-a' });
  const second = { ...first, messageId: 'message-b' };
  const message = { kind: 'assistant', ts: iso(now), text: 'Content withheld for privacy.', eventId: 'event-a' };
  const diagnostics = {};
  const [result] = strictWindowSessions([
    session({ usageEvents: [first], events: [message] }),
    session({ file: '/fixture/b.jsonl', usageEvents: [second], events: [{ ...message, eventId: 'event-b' }] }),
  ], { days: 30, now, diagnostics });
  assert.equal(result.usageEvents.length, 2);
  assert.equal(result.events.length, 2);
  assert.equal(diagnostics.duplicateUsageEvents, 0);
  assert.equal(diagnostics.duplicateActivityEvents, 0);
});

test('matching history across distinct IDs is retained even with a parent link', () => {
  const copied = usage(now - 1000, 100, { id: 'same-local-event-id' });
  const diagnostics = {};
  const result = strictWindowSessions([
    session({ id: 'parent', children: ['child'], usageEvents: [copied] }),
    session({ id: 'child', file: '/fixture/child.jsonl', parent: 'parent', usageEvents: [structuredClone(copied)] }),
    session({ id: 'independent', file: '/fixture/independent.jsonl', usageEvents: [structuredClone(copied)] }),
  ], { days: 30, now, diagnostics });
  assert.equal(result.length, 3);
  assert.equal(result[1].parent, 'codex:parent');
  assert.equal(result.reduce((sum, row) => sum + row.usageEvents.length, 0), 3);
  assert.equal(diagnostics.duplicateSessionFiles, 0);
  assert.equal(diagnostics.duplicateUsageEvents, 0);
});

test('duplicate audit is scoped to the exact rolling calendar window and accumulates safely', () => {
  const events = [usage(bounds.from - 1), usage(bounds.from), usage(now), usage(now + 1), { ...usage(now), ts: null }];
  const diagnostics = {};
  const parts = [session({ usageEvents: events }), session({ file: '/fixture/b.jsonl', usageEvents: structuredClone(events) })];
  const first = strictWindowSessions(parts, { days: 30, now, diagnostics });
  assert.equal(first[0].usageEvents.length, 2);
  assert.equal(diagnostics.duplicateUsageEvents, 2);
  assert.equal(diagnostics.duplicateSessionFiles, 1);
  const next = strictWindowSessions(parts, { days: 1, now, diagnostics });
  assert.equal(next[0].usageEvents.length, 1);
  assert.equal(diagnostics.duplicateUsageEvents, 3);
  assert.equal(diagnostics.bySource.codex.duplicateUsageEvents, 3);
  assert.equal(diagnostics.duplicateSessionFiles, 2);
  const emptyDiagnostics = {};
  assert.equal(strictWindowSessions([session({ usageEvents: [usage(bounds.from - 1)] })], { days: 30, now, diagnostics: emptyDiagnostics }).length, 0);
  assert.equal(emptyDiagnostics.duplicateUsageEvents, 0);
  assert.equal(emptyDiagnostics.duplicateSessionFiles, 0);
  assert.equal(Object.keys(emptyDiagnostics.bySource).length, 0);
});
