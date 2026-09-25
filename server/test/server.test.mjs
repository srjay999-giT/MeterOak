import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('dashboard server did not start')), 8_000);
    let output = '';
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes('running at')) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`dashboard server exited early (${code}): ${output}`));
    });
  });
}

test('dashboard API routes remain available and the reader serves the MeterOak build', async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, [
    'server.mjs', '--dir', './test/fixtures/sample-data', '--days', '3650', '--port', String(port),
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  await waitForReady(child);

  const base = `http://127.0.0.1:${port}`;
  const dashboardResponse = await fetch(`${base}/api/dashboard`);
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.ok(dashboard.generatedAt);
  assert.ok(Array.isArray(dashboard.sourceStatus));
  assert.ok(dashboard.state.sessions.length > 0);
  assert.equal(dashboard.stats.totals.sessions, dashboard.state.sessions.length);
  assert.equal(dashboard.sourceStats.openclaw.totals.sessions, dashboard.state.sessions.length);

  const [stateResponse, statsResponse] = await Promise.all([
    fetch(`${base}/api/state`), fetch(`${base}/api/stats`),
  ]);
  assert.equal(stateResponse.status, 200);
  assert.equal(statsResponse.status, 200);
  const state = await stateResponse.json();
  const stats = await statsResponse.json();
  assert.ok(state.sessions.length > 0);
  assert.ok(stats.totals.sessions > 0);
  assert.equal(state.generatedAt, dashboard.generatedAt);
  assert.equal(stats.burn.asOf, dashboard.generatedAt);

  const sessionResponse = await fetch(`${base}/api/session?id=${encodeURIComponent(state.sessions[0].id)}`);
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).id, state.sessions[0].id);
  assert.equal((await fetch(`${base}/api/session?id=missing-test-session`)).status, 404);

  const pageResponse = await fetch(base);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /<title>MeterOak<\/title>/);
  const assets = [...new Set([...page.matchAll(/(?:src|href)="(\/[^\"]+)"/g)].map((match) => match[1]))].filter((asset) => asset !== '/');
  assert.ok(assets.includes('/meteroak-favicon.svg'));
  assert.ok(assets.includes('/meteroak-intro.css'));
  assert.ok(assets.includes('/meteroak-intro.js'));
  assert.ok(assets.some((asset) => /^\/assets\/.+\.js$/.test(asset)));
  assert.ok(assets.some((asset) => /^\/assets\/.+\.css$/.test(asset)));
  for (const asset of assets) {
    assert.equal((await fetch(`${base}${asset}`)).status, 200, `Missing MeterOak build asset: ${asset}`);
  }
});

test('one unavailable source never prevents the healthy source from rendering', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-hub-server-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const codexHome = path.join(fixture, 'codex');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '08', '20');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rollout = path.join(sessionsDir, 'rollout-2026-08-20T00-00-00-123e4567-e89b-12d3-a456-426614174000.jsonl');
  fs.writeFileSync(rollout, [
    { timestamp: '2026-08-20T10:00:00.000Z', type: 'session_meta', payload: { id: 'healthy-codex', cwd: '/fixture' } },
    { timestamp: '2026-08-20T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.3-codex' } },
    { timestamp: '2026-08-20T10:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 }, last_token_usage: { input_tokens: 100, output_tokens: 20 } }, rate_limits: { primary: { used_percent: 25, window_minutes: 300, resets_at: 1_787_228_800 } } } },
  ].map(JSON.stringify).join('\n'));

  const brokenDb = path.join(fixture, 'broken-opencode.db');
  const db = new DatabaseSync(brokenDb);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY)');
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, [
    'server.mjs', '--sources', 'codex,opencode', '--all', '--port', String(port),
  ], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODE_DB: brokenDb },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForReady(child);

  const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(response.status, 200);
  const dashboard = await response.json();
  assert.equal(dashboard.state.counts.codex, 1);
  assert.equal(dashboard.sourceStats.codex.usage.eventCount, 1);
  const opencode = dashboard.sourceStatus.find((row) => row.source === 'opencode');
  assert.equal(opencode.available, false);
  assert.equal(opencode.failedFiles, 1);
  assert.equal(opencode.issues[0].kind, 'read-error');
  assert.ok(opencode.issues[0].file.endsWith('broken-opencode.db'));
  assert.match(opencode.warning, /could not be read/i);
  assert.match(opencode.issues[0].message, /incompatible/i);
});

test('strict dashboard filters usage timestamps and merges overlapping task logs', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-hub-strict-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const sessionsDir = path.join(fixture, 'sessions');
  fs.mkdirSync(sessionsDir);
  const now = Date.now();
  const stamp = (ms) => new Date(ms).toISOString();
  const meta = { timestamp: stamp(now - 40 * 86400000), type: 'session_meta', payload: { id: 'shared-task', cwd: '/fixture' } };
  const context = { timestamp: stamp(now - 40 * 86400000), type: 'turn_context', payload: { model: 'gpt-5.3-codex' } };
  const event = (ts, input) => ({ timestamp: stamp(ts), type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 10 }, last_token_usage: { input_tokens: input, output_tokens: 10 } },
  } });
  const shared = event(now - 3000, 100);
  fs.writeFileSync(path.join(sessionsDir, 'a.jsonl'), [meta, context, event(now - 40 * 86400000, 900), shared, event(now - 2000, 200)].map(JSON.stringify).join('\n'));
  fs.writeFileSync(path.join(sessionsDir, 'b.jsonl'), [meta, context, shared, event(now - 1000, 300)].map(JSON.stringify).join('\n'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs', '--sources', 'codex', '--days', '30', '--strict-window', '--port', String(port)], {
    cwd: root, env: { ...process.env, CODEX_HOME: fixture }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForReady(child);
  const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.windowMode, 'strict');
  assert.equal(result.windowDays, 30);
  assert.equal(result.state.sessions.length, 1);
  assert.equal(result.state.sessions[0].id, 'codex:shared-task');
  assert.equal(result.state.sessions[0].stats.tokensIn, 600);
  assert.equal(result.stats.usage.eventCount, 3);
  assert.equal(result.stats.usage.tokens.total, 630);
  assert.equal(result.sourceStatus[0].sessions, 1);
  assert.equal(result.sourceStats.codex.usage.tokens.total, 630);
  assert.equal(result.stats.perDay.reduce((sum, day) => sum + day.tokensIn + day.tokensOut, 0), 630);
  assert.equal(result.stats.cost.sessions[0].apiCost, result.stats.usage.cost.usd);
  assert.equal(result.stats.models[0].days.length, 30);
  assert.equal(result.stats.models[0].days.reduce((sum, day) => sum + day.tokens.total, 0), 630);
  const activeDay = result.stats.perDay.find((day) => day.eventCount > 0);
  assert.equal(activeDay.eventCount, 3);
  assert.equal(activeDay.cost.coverage, 1);
  assert.equal(activeDay.cost.unpricedEvents, 0);
  assert.equal(activeDay.cost.usd, result.stats.usage.cost.usd);
});

test('strict snapshot recovers usage after oversized records and exposes incomplete scans and duplicates', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-hub-integrity-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const dir = path.join(fixture, 'sessions');
  fs.mkdirSync(dir);
  const now = Date.now();
  const stamp = (offset) => new Date(now + offset).toISOString();
  const meta = { type: 'session_meta', timestamp: stamp(-6000), payload: { id: 'one-task' } };
  const context = (model, offset) => ({ type: 'turn_context', timestamp: stamp(offset), payload: { model } });
  const token = (offset, last, total = last) => ({ type: 'event_msg', timestamp: stamp(offset), payload: {
    type: 'token_count', info: { last_token_usage: last, total_token_usage: total },
  } });
  const first = token(-4000, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 10 });
  const second = token(-2000,
    { input_tokens: 200, cached_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 20 },
    { input_tokens: 300, cached_input_tokens: 140, output_tokens: 80, reasoning_output_tokens: 30 });
  const file = path.join(dir, 'large.jsonl');
  const lines = [
    JSON.stringify(meta), JSON.stringify(context('gpt-5.6-sol', -5000)), JSON.stringify(first),
    null,
    '{invalid-json}', JSON.stringify(context('codex-auto-review', -3000)), JSON.stringify(second),
    '{"timestamp":"',
  ];
  const fd = fs.openSync(file, 'w');
  try {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === null) {
        fs.writeSync(fd, '{"type":"response_item","payload":{"content":"');
        const block = Buffer.alloc(1024 * 1024, 'x');
        for (let chunk = 0; chunk < 64; chunk++) fs.writeSync(fd, block);
        fs.writeSync(fd, '"}}');
      } else fs.writeSync(fd, lines[i]);
      if (i < lines.length - 1) fs.writeSync(fd, '\n');
    }
  } finally { fs.closeSync(fd); }
  // A copied file's mtime is not authoritative for the usage inside it.
  const old = new Date(now - 40 * 86400000);
  fs.utimesSync(file, old, old);
  fs.writeFileSync(path.join(dir, 'copy.jsonl'), [meta, context('gpt-5.6-sol', -5000), first].map(JSON.stringify).join('\n'));
  const port = await freePort();
  const readErrorMarker = path.join(fixture, 'deny-read');
  const child = spawn(process.execPath, ['--import', './test/helpers/read-error.mjs', 'server.mjs', '--sources', 'codex', '--days', '30', '--strict-window', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env, CODEX_HOME: fixture,
      METEROAK_TEST_READ_ERROR_PATH: file, METEROAK_TEST_READ_ERROR_MARKER: readErrorMarker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForReady(child);
  const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(response.status, 200);
  const result = await response.json();
  const status = result.sourceStatus[0];
  assert.equal(status.scannedFiles, 2);
  assert.equal(status.failedFiles, 0);
  assert.equal(status.malformedLines, 1);
  assert.equal(status.oversizedLines, 1);
  assert.equal(status.pendingLines, 1);
  assert.equal(status.duplicateUsageEvents, 1);
  assert.equal(status.duplicateSessionFiles, 1);
  assert.match(status.warning, /incomplete/);
  assert.deepEqual(status.issues.map((issue) => issue.kind).sort(), ['malformed-record', 'oversized-record', 'pending-write']);
  const usage = result.stats.usage;
  assert.equal(usage.eventCount, 2);
  assert.deepEqual(usage.tokens, { input: 160, output: 50, reasoning: 30, cacheRead: 140, cacheWrite: 0, total: 380 });
  assert.equal(usage.cost.unpricedEvents, 1);
  assert.equal(usage.cost.coverage, 0.5);
  assert.ok(Math.abs(usage.cost.usd - 0.000856) < 1e-12);
  for (const rows of [result.stats.models, result.stats.perDay]) {
    assert.equal(rows.reduce((sum, row) => sum + row.tokens.total, 0), usage.tokens.total);
    assert.ok(Math.abs(rows.reduce((sum, row) => sum + (row.cost.usd ?? 0), 0) - usage.cost.usd) < 1e-12);
  }
  assert.equal(result.stats.cost.sessions[0].unpricedEvents, 1);
  assert.equal(result.stats.cost.sessions[0].apiCost, usage.cost.usd);

  // Permission changes must invalidate the file cache even when size/mtime
  // stay unchanged, and retaining a prior readable result must be disclosed.
  // Inject EACCES deterministically: synced folders or privileged runners can
  // restore or bypass mode bits while the test waits for the cache to expire.
  fs.writeFileSync(readErrorMarker, '');
  fs.chmodSync(file, 0);
  try {
    await new Promise((resolve) => setTimeout(resolve, 9100));
    const stale = await (await fetch(`http://127.0.0.1:${port}/api/dashboard`)).json();
    assert.equal(stale.sourceStatus[0].failedFiles, 1);
    assert.equal(stale.sourceStatus[0].staleFiles, 1);
    assert.equal(stale.sourceStatus[0].scannedFiles, 1);
    assert.ok(stale.sourceStatus[0].issues.some((issue) => issue.kind === 'stale-file'));
    assert.equal(stale.stats.usage.tokens.total, 380);
  } finally { fs.chmodSync(file, 0o600); }
});
