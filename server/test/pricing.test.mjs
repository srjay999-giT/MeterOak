import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildStats, priceSession, sessionSummary } from '../analytics.mjs';

const pricing = JSON.parse(fs.readFileSync(new URL('../pricing.json', import.meta.url), 'utf8'));
const now = '2026-09-24T12:00:00.000Z';
const event = (model, values = {}) => ({
  ts: '2026-09-24T10:00:00.000Z', provider: 'openai', model,
  tokensIn: 100000, tokensCacheRead: 171999, tokensCacheWrite: 1,
  tokensOut: 20, tokensReasoning: 10, ...values,
});
const session = (events, model = 'gpt-5.6-sol') => ({
  id: 'fixture', source: 'codex', model, label: 'Fixture',
  startedAt: now, endedAt: now, parent: null, children: [], events: [],
  usageEvents: events, limitSnapshots: [],
  stats: { tokensIn: 1000000, tokensOut: 100000, tokensCacheRead: 400000, tokensCacheWrite: 0, toolCounts: {}, messages: 0, errors: 0 },
});
const statsFor = (value) => buildStats([value], { days: 30, now, pricing });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('Sol prices exact 272K at short rates and higher per-request input at full long rates', () => {
  const short = event('gpt-5.6-sol');
  const long = event('gpt-5.6-sol', { tokensCacheRead: 172000 });
  const shortCost = (100000 * 4 + 171999 * 0.4 + 1 * 5 + 30 * 20) / 1e6;
  const longCost = (100000 * 8 + 172000 * 0.8 + 1 * 10 + 30 * 30) / 1e6;
  close(priceSession(session([short]), pricing).total, shortCost);
  close(priceSession(session([long]), pricing).total, longCost);
  const stats = statsFor(session([long, short]));
  close(stats.usage.cost.usd, shortCost + longCost);
  assert.equal(stats.usage.cost.longContextEvents, 1);
  assert.equal(stats.models[0].cost.longContextEvents, 1);
  assert.equal(stats.perDay.at(-1).cost.longContextEvents, 1);
  assert.equal(stats.models[0].rate.input, 4); // First event is long, canonical rate is short.
  assert.equal(stats.models[0].rate.longContext.input, 8);
  assert.equal(stats.models[0].rate.longContext.thresholdInputTokens, 272000);
  assert.equal(stats.models[0].rate.serviceTier, 'standard');
  assert.equal(stats.models[0].rate.verifiedAt, '2026-09-24');
});

test('Astra uses verified cache/read/write and reasoning prices, without mapping other model names', () => {
  const short = event('gpt-6-astra');
  const long = event('gpt-6-astra', { tokensCacheRead: 172000 });
  close(priceSession(session([short]), pricing).total, (100000 * 10 + 171999 * 1 + 12.5 + 30 * 50) / 1e6);
  close(priceSession(session([long]), pricing).total, (100000 * 20 + 172000 * 2 + 25 + 30 * 75) / 1e6);
  for (const model of ['codex-auto-review', 'gpt-6-sol', 'gpt-6-astra-fast', 'unrecognized-model']) {
    assert.equal(priceSession(session([event(model)]), pricing).total, null);
  }
});

test('context pricing uses each event rather than a session total or the model context capacity', () => {
  const small = event('gpt-5.6-sol', {
    tokensIn: 200000, tokensCacheRead: 0, tokensCacheWrite: 0,
    tokensOut: 0, tokensReasoning: 0, contextWindowTokens: 1050000,
  });
  const value = session([small, { ...small, ts: '2026-09-24T11:00:00.000Z' }]);
  const stats = statsFor(value);
  close(stats.usage.cost.usd, 1.6);
  assert.equal(stats.usage.cost.longContextEvents, 0);
  assert.equal(stats.usage.cost.contextUncertainEvents, 0);
  const legacy = priceSession(session([]), pricing);
  close(legacy.total, (600000 * 4 + 400000 * 0.4 + 100000 * 20) / 1e6);
  assert.equal(legacy.longContextEvents, 0);
  assert.equal(legacy.contextUncertainEvents, 1);
});

test('mixed-model session costs reconcile everywhere and preserve reported/free costs', () => {
  const events = [
    event('gpt-5.6-sol'),
    event('gpt-6-astra', { tokensCacheRead: 172000, costUsd: 0.123 }),
    event('gpt-6-astra', { tokensCacheRead: 172000, costUsd: 0 }),
  ];
  const value = session(events, 'gpt-6-astra');
  const priced = priceSession(value, pricing);
  const expected = (100000 * 4 + 171999 * 0.4 + 5 + 30 * 20) / 1e6 + 0.123;
  const stats = statsFor(value);
  const summary = sessionSummary(value, pricing);
  close(priced.total, expected);
  close(stats.usage.cost.usd, expected);
  close(stats.cost.sessions[0].apiCost, expected);
  close(summary.intelligence.apiCost, expected);
  close(stats.models.reduce((sum, row) => sum + (row.cost.usd ?? 0), 0), expected);
  close(stats.perDay.reduce((sum, row) => sum + (row.cost.usd ?? 0), 0), expected);
  assert.equal(priced.rate, null); // Mixed models never pretend to share one rate.
  assert.equal(priced.rates.length, 2);
  assert.equal(stats.cost.sessions[0].rate, null);
  assert.equal(summary.intelligence.costProvenance, 'mixed');
  assert.equal(stats.usage.cost.reportedUsd, 0.123);
  assert.equal(stats.usage.cost.pricedEvents, 3);
  assert.equal(stats.usage.cost.longContextEvents, 0); // Reported costs are not repriced.
  assert.equal(stats.usage.cost.contextUncertainEvents, 0);
  const partial = priceSession(session([event('gpt-5.6-sol'), event('unrecognized-model')]), pricing);
  assert.equal(partial.rate, null);
  assert.equal(partial.coverage, 0.5);
  assert.equal(partial.unpricedEvents, 1);
});

test('pricing verification metadata is per entry and only names the refreshed models', () => {
  const stats = statsFor(session([event('gpt-6-astra')]));
  assert.equal(stats.pricing.assumption, 'standard-api-token-rates');
  assert.equal(stats.pricing.tableUpdatedAt, '2026-09-24');
  assert.deepEqual(stats.pricing.verifiedModels.map((row) => row.id).sort(), ['gpt-5.6-sol', 'gpt-6-astra']);
  assert.ok(stats.pricing.verifiedModels.every((row) => row.sourceUrl.startsWith('https://developers.openai.com/api/docs/models/')));
  const legacyModel = pricing.models.find((row) => row.id === 'gpt-5.3-codex');
  assert.equal(legacyModel.input, 1.75);
  assert.equal(legacyModel.verifiedAt, undefined);
});

test('missing per-request model stays unpriced even when a later session model is known', () => {
  const unknown = event(null, { tokensIn: 100, tokensCacheRead: 0, tokensCacheWrite: 0, tokensOut: 10, tokensReasoning: 0 });
  const stats = statsFor(session([unknown, event('gpt-6-astra')], 'gpt-6-astra'));
  const row = stats.models.find((model) => model.model === '(unknown model)');
  assert.equal(row.tokens.total, 110);
  assert.equal(row.cost.usd, null);
  assert.equal(row.cost.unpricedEvents, 1);
  assert.equal(stats.usage.cost.unpricedEvents, 1);
  assert.equal(stats.usage.tokens.total, stats.models.reduce((sum, model) => sum + model.tokens.total, 0));
});
