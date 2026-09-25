#!/usr/bin/env node
/**
 * Unified AI Usage Hub — read-only intelligence for agent CLI sessions
 * transcripts: OpenClaw (incl. clawdbot/moltbot), Claude Code, Codex CLI, and
 * Hermes (best-effort). Reconstructs per-session trajectories and sub-agent
 * spawn trees and serves a local web UI. Never writes to any state directory.
 *
 * Usage:
 *   node server.mjs                          # Codex + OpenCode (default)
 *   node server.mjs --sources all            # discover every supported source
 *   node server.mjs --sources claude-code    # only some sources (comma list)
 *   node server.mjs --dir ./sample-data      # explicit OpenClaw-layout dir only
 *   node server.mjs --days 90 | --all        # recency window (default 30 days)
 *   node server.mjs --strict-window         # Codex/OpenCode calendar-window usage
 *   node server.mjs --pricing ./rates.json   # custom per-model API rates
 *   node server.mjs --port 5000              # default 4488
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAdapters } from './adapters.mjs';
import { buildStats, sessionSummary } from './analytics.mjs';
import { calendarWindow, strictWindowSessions } from './window.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- CLI / config
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const PORT = Number(argValue('--port') || process.env.PORT || 4488);
const explicitDir = argValue('--dir') || process.env.OPENCLAW_STATE_DIR || null;
const sourceArg = argValue('--sources');
const sources = sourceArg === 'all'
  ? null
  : sourceArg
    ? sourceArg.split(',').map((s) => s.trim()).filter(Boolean)
    : explicitDir ? ['openclaw'] : ['codex', 'opencode'];
const days = args.includes('--all') ? Infinity : Number(argValue('--days') || 30);
const strictWindow = args.includes('--strict-window');
if (strictWindow) calendarWindow(days);
const pricingFile = path.resolve(
  argValue('--pricing')
  || process.env.VISUALISATION_DASHBOARD_PRICING
  || process.env.OPENCLAW_VIS_PRICING
  || path.join(__dirname, 'pricing.json'),
);
let pricing = null;
try { pricing = JSON.parse(fs.readFileSync(pricingFile, 'utf8')); }
catch (err) { console.warn(`pricing disabled: could not read ${pricingFile} (${err.message})`); }

const adapters = makeAdapters({ explicitDir, sources });
if (strictWindow && adapters.some((adapter) => !['codex', 'opencode'].includes(adapter.source))) {
  throw new Error('--strict-window supports timestamped codex and opencode sources only');
}

// ---------------------------------------------------------------- state (cached)
const cache = new Map(); // source:file -> { fingerprint, sessions }
// The UI polls every ten seconds. Reusing a scan for nine seconds gives all
// compatibility routes one coherent view without delaying the next poll.
const STATE_CACHE_MS = 9_000;
let stateCache = null;

function buildState() {
  const scanNow = Date.now();
  const cutoff = strictWindow ? calendarWindow(days, scanNow).from
    : Number.isFinite(days) ? scanNow - days * 86_400_000 : -Infinity;
  let sessions = [];
  const roots = new Set();
  const liveKeys = new Set();
  const sourceStatus = [];

  for (const adapter of adapters) {
    const status = {
      source: adapter.source, available: false, files: 0, scannedFiles: 0,
      failedFiles: 0, staleFiles: 0, malformedLines: 0, oversizedLines: 0,
      pendingLines: 0, contentTruncations: 0, duplicateUsageEvents: 0,
      duplicateSessionFiles: 0, sessions: 0, freshAt: null, warning: null, issues: [],
    };
    sourceStatus.push(status);
    let descriptors = [];
    const discoveryDiagnostics = {};
    try { descriptors = adapter.findFiles({ diagnostics: discoveryDiagnostics }); }
    catch (err) {
      status.warning = err.message || String(err);
      status.issues.push({ kind: 'scan-error', file: null, message: status.warning });
    }
    for (const issue of discoveryDiagnostics.issues ?? []) {
      status.issues.push({ ...issue, file: issue.file ? shortPath(issue.file) : null });
    }
    if (discoveryDiagnostics.issues?.length) {
      status.warning = `${discoveryDiagnostics.issues.length} locations could not be inspected. Totals may be incomplete.`;
    }
    status.files = descriptors.length;

    for (const desc of descriptors) {
      const key = `${adapter.source}:${desc.file}`;
      liveKeys.add(key);
      let entry = cache.get(key);
      let failed = false;
      try {
        const st = fs.statSync(desc.file);
        // Strict views use record timestamps, including copied logs whose file
        // modification time does not describe the usage they contain.
        if (!strictWindow && !adapter.fingerprint && st.mtimeMs < cutoff) continue;
        const fingerprint = adapter.fingerprint
          ? String(adapter.fingerprint(desc))
          : `${st.dev}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
        if (!entry || entry.fingerprint !== fingerprint) {
          // Sever links into stale sibling objects from a previous parse.
          const diagnostics = {};
          const parsed = adapter.parseFile(desc, { diagnostics });
          entry = { fingerprint, sessions: parsed, diagnostics };
          cache.set(key, entry);
        }
        status.scannedFiles++;
      } catch (err) {
        failed = true;
        status.failedFiles++;
        if (entry) status.staleFiles++;
        status.issues.push({
          file: shortPath(desc.file), kind: entry ? 'stale-file' : 'read-error',
          message: `${entry ? 'Showing the last readable version. ' : ''}${String(err.message || err).slice(0, 300)}`,
        });
        if (!entry) continue;
      }
      for (const field of ['malformedLines', 'oversizedLines', 'pendingLines', 'contentTruncations']) {
        status[field] += entry.diagnostics?.[field] ?? 0;
      }
      for (const [field, kind, label] of [
        ['malformedLines', 'malformed-record', 'unreadable JSON records'],
        ['oversizedLines', 'oversized-record', 'records exceeding the safe per-record size'],
        ['pendingLines', 'pending-write', 'unfinished records waiting for the writer'],
      ]) {
        const count = entry.diagnostics?.[field] ?? 0;
        if (count) status.issues.push({ file: shortPath(desc.file), kind, count, message: `${count} ${label}${failed ? ' in the cached version' : ''}.` });
      }
      for (const s of entry.sessions) {
        const activity = Date.parse(s.endedAt || s.startedAt || '');
        if (!strictWindow && Number.isFinite(activity) && activity < cutoff) continue;
        sessions.push(s);
        status.sessions++;
        if ((s.endedAt || s.startedAt || '') > (status.freshAt || '')) status.freshAt = s.endedAt || s.startedAt;
        roots.add(`${adapter.source}: ${shortPath(path.dirname(desc.file))}`);
      }
    }
    const warnings = [];
    if (status.failedFiles) warnings.push(`${status.failedFiles} files could not be read`);
    if (status.staleFiles) warnings.push(`${status.staleFiles} files use an older cached version`);
    if (status.malformedLines) warnings.push(`${status.malformedLines} unreadable records were skipped`);
    if (status.oversizedLines) warnings.push(`${status.oversizedLines} oversized records were skipped`);
    if (warnings.length) status.warning = `${warnings.join('; ')}. Totals may be incomplete.`;
    status.available = status.scannedFiles > 0 || status.sessions > 0;
    if (!status.files && !status.warning) status.warning = 'No local data source found';
  }
  for (const key of cache.keys()) if (!liveKeys.has(key)) cache.delete(key);

  if (strictWindow) {
    const diagnostics = {};
    sessions = strictWindowSessions(sessions, { days, now: scanNow, diagnostics });
    for (const status of sourceStatus) {
      Object.assign(status, diagnostics.bySource?.[status.source] ?? {});
      const selected = sessions.filter((session) => session.source === status.source);
      status.sessions = selected.length;
      status.available = status.scannedFiles > 0 || status.sessions > 0;
      status.freshAt = selected.flatMap((session) => [
        ...session.usageEvents, ...session.events, ...session.limitSnapshots,
      ]).map((event) => event.ts).filter(Boolean).sort().at(-1) ?? null;
    }
  }

  // Cross-session spawn linking (OpenClaw-style: spawn tool calls referencing
  // another session's UUID). Same-file links (Claude Code sidechains) are
  // already set by the adapter; reset nothing, only add missing edges.
  const byId = new Map(sessions.map((s) => [s.id.toLowerCase(), s]));
  for (const s of sessions) {
    for (const { uuid, ev } of s.spawnCandidates) {
      const child = byId.get(uuid);
      if (child && child !== s && !child.parent) {
        child.parent = s.id;
        if (!s.children.includes(child.id)) s.children.push(child.id);
        ev.tool.spawnTarget ??= child.id;
      }
    }
  }
  return { generatedAt: new Date(strictWindow ? scanNow : Date.now()).toISOString(), roots: [...roots].sort(), sessions, byId, sourceStatus };
}

function cachedState() {
  const now = Date.now();
  if (!stateCache || now - stateCache.builtAt >= STATE_CACHE_MS) {
    stateCache = { builtAt: now, value: buildState() };
  }
  return stateCache.value;
}

function shortPath(p) {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// ---------------------------------------------------------------- http server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
};
const publicDirectory = path.join(__dirname, '..', 'dist');

function selectSessions(sessions, source) {
  return source && source !== 'all' ? sessions.filter((s) => s.source === source) : sessions;
}

function statePayload(snapshot, source) {
  const counts = {};
  for (const s of snapshot.sessions) counts[s.source] = (counts[s.source] || 0) + 1;
  return {
    roots: snapshot.roots,
    counts,
    generatedAt: snapshot.generatedAt,
    sessions: selectSessions(snapshot.sessions, source).map((s) => sessionSummary(s, pricing)),
  };
}

export function buildDashboardSnapshot(source = 'all') {
  const snapshot = cachedState();
  const generatedAt = snapshot.generatedAt;
  const selected = selectSessions(snapshot.sessions, source);
  const sourceNames = new Set([
    ...adapters.map((adapter) => adapter.source),
    ...snapshot.sessions.map((session) => session.source),
  ]);
  const sourceStats = Object.fromEntries([...sourceNames].map((name) => [
    name,
    buildStats(snapshot.sessions.filter((session) => session.source === name), { days, pricing, now: generatedAt }),
  ]));
  return {
    generatedAt,
    ...(strictWindow ? { windowMode: 'strict', windowDays: days } : {}),
    sourceStatus: snapshot.sourceStatus,
    state: { ...statePayload(snapshot, source), generatedAt },
    stats: buildStats(selected, { days, pricing, now: generatedAt }),
    sourceStats,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/state') {
      const src = url.searchParams.get('source');
      return json(res, statePayload(cachedState(), src));
    }
    if (url.pathname === '/api/stats') {
      const src = url.searchParams.get('source');
      const snapshot = cachedState();
      let { sessions } = snapshot;
      sessions = selectSessions(sessions, src);
      return json(res, buildStats(sessions, { days, pricing, now: snapshot.generatedAt }));
    }
    if (url.pathname === '/api/dashboard') {
      return json(res, buildDashboardSnapshot(url.searchParams.get('source') || 'all'));
    }
    if (url.pathname === '/api/session') {
      const id = (url.searchParams.get('id') || '').toLowerCase();
      const { byId } = cachedState();
      const s = byId.get(id);
      if (!s) return json(res, { error: 'session not found' }, 404);
      return json(res, sessionSummary(s, pricing, true));
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(publicDirectory, p);
    if (filePath.startsWith(publicDirectory) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      return res.end(fs.readFileSync(filePath));
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    json(res, { error: String(err) }, 500);
  }
});

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, '127.0.0.1', () => {
  const t0 = Date.now();
  const state = cachedState();
  const bySource = {};
  for (const s of state.sessions) bySource[s.source] = (bySource[s.source] || 0) + 1;
  console.log(`Unified AI Usage Hub running at http://127.0.0.1:${PORT}`);
  console.log(`sources: ${adapters.map((a) => a.source).join(', ')} | window: ${Number.isFinite(days) ? `last ${days} days` : 'all history'}`);
  console.log(`sessions: ${state.sessions.length} ${JSON.stringify(bySource)} (initial scan ${Date.now() - t0}ms)`);
  for (const status of state.sourceStatus) if (status.warning) console.log(`${status.source}: ${status.warning}`);
  if (!state.sessions.length) console.log('none found — try "npm run sample" for demo data, or --all to widen the window');
});
