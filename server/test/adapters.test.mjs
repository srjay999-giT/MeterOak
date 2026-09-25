import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  discoverOpenCodeDatabase,
  makeAdapters,
  newSession,
  parseCodexFile,
  parseCodexLastTokenUsage,
  parseCodexRateLimits,
  parseCodexTokenCount,
  parseOpenCodeDatabase,
  sqliteFingerprint,
} from '../adapters.mjs';

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* OpenCode tests skip on Node <22.5 */ }

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-adapters-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('newSession includes normalized usage and limit collections', () => {
  const session = newSession('codex', '/tmp/session.jsonl', 'codex');
  assert.deepEqual(session.usageEvents, []);
  assert.deepEqual(session.limitSnapshots, []);
});

test('Codex helpers separate cache and reasoning tokens and parse both limit windows', () => {
  const ts = '2026-08-20T10:00:00.000Z';
  const usage = parseCodexLastTokenUsage({
    input_tokens: 100,
    cached_input_tokens: 40,
    output_tokens: 30,
    reasoning_output_tokens: 10,
  }, { ts, model: 'gpt-5.6-codex', contextWindowTokens: 258_400 });
  assert.deepEqual(usage, {
    ts,
    source: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-codex',
    tokensIn: 60,
    tokensOut: 20,
    tokensReasoning: 10,
    tokensCacheRead: 40,
    tokensCacheWrite: 0,
    total: 130,
    costUsd: null,
    contextWindowTokens: 258_400,
  });

  const rateLimits = {
    limit_id: 'codex',
    limit_name: 'Codex',
    plan_type: 'plus',
    primary: { used_percent: 25, window_minutes: 300, resets_at: 1_787_228_800 },
    secondary: { used_percent: 60, window_minutes: 10_080, resets_at: 1_787_832_000 },
  };
  const snapshots = parseCodexRateLimits(rateLimits, { ts });
  assert.deepEqual(snapshots.map((item) => [item.window, item.usedPercent, item.remainingPercent]), [
    ['primary', 25, 75],
    ['secondary', 60, 40],
  ]);
  assert.ok(snapshots.every((item) => item.resetsAt?.endsWith('Z')));

  const parsed = parseCodexTokenCount({
    info: { last_token_usage: { input_tokens: 10, output_tokens: 2 }, model_context_window: 1_000 },
    rate_limits: rateLimits,
  }, { ts, model: 'gpt-5.6-codex' });
  assert.equal(parsed.usageEvent.model, 'gpt-5.6-codex');
  assert.equal(parsed.limitSnapshots.length, 2);
});

test('Codex rollout usage follows model switches and ignores repeated cumulative snapshots', (t) => {
  const dir = temporaryDirectory(t);
  const file = path.join(dir, 'rollout-2026-08-20T00-00-00-123e4567-e89b-12d3-a456-426614174000.jsonl');
  const total1 = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 130 };
  const last1 = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 130 };
  const total2 = { input_tokens: 180, cached_input_tokens: 60, output_tokens: 50, reasoning_output_tokens: 15, total_tokens: 230 };
  const last2 = { input_tokens: 80, cached_input_tokens: 20, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 100 };
  const lines = [
    { timestamp: '2026-08-20T10:00:00.000Z', type: 'session_meta', payload: { id: 'session-codex', cwd: '/work/demo' } },
    { timestamp: '2026-08-20T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-model-a' } },
    { timestamp: '2026-08-20T10:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total1, last_token_usage: last1, model_context_window: 1_000 }, rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1_787_228_800 } } } },
    { timestamp: '2026-08-20T10:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total1, last_token_usage: last1, model_context_window: 1_000 }, rate_limits: { primary: { used_percent: 11, window_minutes: 300, resets_at: 1_787_228_800 } } } },
    { timestamp: '2026-08-20T10:00:04.000Z', type: 'turn_context', payload: { model: 'gpt-model-b' } },
    { timestamp: '2026-08-20T10:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total2, last_token_usage: last2, model_context_window: 2_000 }, rate_limits: { secondary: { used_percent: 20, window_minutes: 10_080, resets_at: 1_787_832_000 } } } },
    { timestamp: '2026-08-20T10:00:06.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'RAW CODEX PROMPT MUST NOT LEAK' }] } },
    { timestamp: '2026-08-20T10:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RAW CODEX RESPONSE MUST NOT LEAK' }] } },
  ];
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n'));

  const [session] = parseCodexFile(file);
  assert.equal(session.model, 'gpt-model-b');
  assert.deepEqual(session.usageEvents.map((item) => item.model), ['gpt-model-a', 'gpt-model-b']);
  assert.deepEqual(session.usageEvents.map((item) => item.total), [130, 100]);
  assert.equal(session.limitSnapshots.length, 3);
  assert.equal(session.stats.tokensIn, 180);
  assert.equal(session.stats.tokensOut, 50);
  assert.equal(session.stats.tokensCacheRead, 60);
  assert.match(session.label, /^Codex · gpt-model-b/);
  assert.doesNotMatch(JSON.stringify(session), /RAW CODEX PROMPT|RAW CODEX RESPONSE/);
});

test('OpenCode discovery gives OPENCODE_DB precedence and registers the adapter', () => {
  const configured = discoverOpenCodeDatabase({ env: { OPENCODE_DB: './custom.db', XDG_DATA_HOME: '/ignored' }, home: '/home/test' });
  assert.equal(configured, path.resolve('./custom.db'));
  const xdg = discoverOpenCodeDatabase({ env: { XDG_DATA_HOME: '/data' }, home: '/home/test' });
  assert.equal(xdg, path.join('/data', 'opencode', 'opencode.db'));
  const adapter = makeAdapters({ sources: ['opencode'] })[0];
  assert.equal(adapter.source, 'opencode');
  assert.equal(typeof adapter.fingerprint, 'function');
});

test('OpenCode reads only assistant usage and safe tool metadata from SQLite', { skip: !DatabaseSync && 'node:sqlite is unavailable' }, (t) => {
  const dir = temporaryDirectory(t);
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'ses-1', null, '/work/alpha', 'Safe generated title', 7, 2, 3, 1_776_672_000_000, 1_776_672_005_000,
  );
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('user-1', 'ses-1', 1_776_672_001_000, JSON.stringify({
    role: 'user',
    content: 'RAW PROMPT MUST NOT LEAK',
  }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('assistant-1', 'ses-1', 1_776_672_002_000, JSON.stringify({
    role: 'assistant',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-test',
    cost: 0.125,
    time: { created: 1_776_672_002_000, completed: 1_776_672_004_000 },
    tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 1 } },
  }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-1', 'assistant-1', 'ses-1', 1_776_672_003_000, JSON.stringify({
    type: 'tool',
    tool: 'bash',
    callID: 'call-1',
    state: {
      status: 'completed',
      input: { command: 'TOOL INPUT MUST NOT LEAK' },
      output: 'TOOL OUTPUT MUST NOT LEAK',
      time: { start: 1_776_672_003_000, end: 1_776_672_004_000 },
    },
  }));
  db.close();

  const before = fs.statSync(file);
  const [session] = parseOpenCodeDatabase(file);
  const after = fs.statSync(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(session.label, 'Safe generated title');
  assert.equal(session.provider, 'anthropic');
  assert.equal(session.model, 'claude-sonnet-test');
  assert.deepEqual(session.summary, { additions: 7, deletions: 2, files: 3 });
  assert.deepEqual(session.usageEvents[0], {
    id: 'assistant-1',
    ts: '2026-04-20T08:00:04.000Z',
    source: 'opencode',
    provider: 'anthropic',
    model: 'claude-sonnet-test',
    tokensIn: 10,
    tokensOut: 4,
    tokensReasoning: 2,
    tokensCacheRead: 6,
    tokensCacheWrite: 1,
    total: 23,
    costUsd: 0.125,
    contextWindowTokens: null,
  });
  assert.equal(session.stats.tokensIn, 17);
  assert.equal(session.stats.tokensOut, 6);
  assert.equal(session.stats.messages, 2);
  assert.deepEqual(session.events[0].tool.args, {});
  assert.equal(session.events[0].tool.result, null);
  const serialized = JSON.stringify(session);
  assert.doesNotMatch(serialized, /RAW PROMPT|TOOL INPUT|TOOL OUTPUT/);
});

test('OpenCode reports incompatible schemas and fingerprints DB sidecars', { skip: !DatabaseSync && 'node:sqlite is unavailable' }, (t) => {
  const dir = temporaryDirectory(t);
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY)');
  db.close();
  assert.throws(() => parseOpenCodeDatabase(file), /incompatible \(missing table: message\)/);

  const first = sqliteFingerprint(file);
  fs.writeFileSync(file + '-wal', 'fixture');
  const second = sqliteFingerprint(file);
  assert.notEqual(second, first);
  assert.match(second, /-wal:/);
  assert.match(second, /-shm:missing/);
});

test('OpenCode preserves free usage and ignores malformed message JSON', { skip: !DatabaseSync && 'node:sqlite is unavailable' }, (t) => {
  const dir = temporaryDirectory(t);
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('free-session', 'Free model', 1_776_672_000_000, 1_776_672_005_000);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('free-message', 'free-session', 1_776_672_002_000, JSON.stringify({
    role: 'assistant', providerID: 'local', modelID: 'free-model', cost: 0,
    tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 1, write: 0 } },
  }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('broken-message', 'free-session', 1_776_672_003_000, '{not-json');
  db.close();

  const [session] = parseOpenCodeDatabase(file);
  assert.equal(session.usageEvents.length, 1);
  assert.equal(session.usageEvents[0].costUsd, 0);
  assert.equal(session.usageEvents[0].total, 6);
  assert.equal(session.stats.messages, 2);
});

test('OpenCode reports a locked database without affecting other adapters', { skip: !DatabaseSync && 'node:sqlite is unavailable' }, (t) => {
  const dir = temporaryDirectory(t);
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT NOT NULL);
    BEGIN EXCLUSIVE;
  `);
  assert.throws(() => parseOpenCodeDatabase(file), /OpenCode database read failed.*(?:locked|busy)/i);
  db.exec('ROLLBACK');
  db.close();
});
