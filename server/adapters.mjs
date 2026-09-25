/**
 * Source adapters — each discovers session transcript files for one agent CLI
 * and parses them into the shared normalized trajectory model:
 *
 *   session: { id, source, agent, file, label, model, startedAt, endedAt,
 *              events[], usageEvents[], limitSnapshots[], stats,
 *              spawnCandidates[], children[], parent }
 *   event:   { kind: user|assistant|thinking|tool|meta, ts, text?, tool? }
 *   tool:    { id, name, args, result, isError, resultTs, spawnTarget? }
 *
 * All adapters are read-only. Optional diagnostics report skipped JSONL records.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SPAWN_TOOL_RE = /spawn|subagent|sub_agent|^task$|^agent$/i;

// ── shared helpers ───────────────────────────────────────────────────────────
export function newSession(source, file, agent) {
  return {
    id: path.basename(file, '.jsonl'),
    source,
    agent,
    file,
    label: '',
    model: null,
    startedAt: null,
    endedAt: null,
    events: [],
    usageEvents: [],
    limitSnapshots: [],
    stats: { toolCounts: {}, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, messages: 0, errors: 0 },
    spawnCandidates: [],
    children: [],
    parent: null,
  };
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.NaN;
  const date = new Date(Number.isFinite(n) ? (n < 10_000_000_000 ? n * 1000 : n) : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function blocksOf(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [content];
}

function textOf(content) {
  return blocksOf(content)
    .map((b) => (typeof b === 'string' ? b : b.text ?? b.thinking ?? ''))
    .filter(Boolean)
    .join('\n');
}

function sumUsage(stats, usage) {
  if (!usage || typeof usage !== 'object') return;
  const cacheRead = usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0;
  // "in" is the full context the model saw (cache reads/writes included)
  stats.tokensIn += (usage.input ?? usage.input_tokens ?? 0) + cacheRead + cacheWrite;
  stats.tokensOut += usage.output ?? usage.output_tokens ?? 0;
  stats.tokensCacheRead += cacheRead;
  stats.tokensCacheWrite += cacheWrite;
}

function diagnostic(diagnostics, field, amount = 1) {
  if (diagnostics) diagnostics[field] = (diagnostics[field] ?? 0) + amount;
}

// Decode complete lines, not chunks, so a UTF-8 character split across reads is
// preserved. A pathological record is discarded through its next newline;
// subsequent usage records remain readable even in multi-gigabyte log files.
export function* jsonLines(file, { diagnostics, chunkSize = 64 * 1024, maxLineBytes = 64 * 1024 * 1024 } = {}) {
  for (const [name, value] of Object.entries({ chunkSize, maxLineBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  const chunk = Buffer.allocUnsafe(chunkSize);
  const fd = fs.openSync(file, 'r');
  let parts = [];
  let lineBytes = 0;
  let oversized = false;
  const finishLine = (atEof = false) => {
    diagnostic(diagnostics, 'linesRead');
    let parsed;
    if (oversized) diagnostic(diagnostics, 'oversizedLines');
    else {
      const line = Buffer.concat(parts, lineBytes).toString('utf8').trim();
      if (line) {
        try {
          const value = JSON.parse(line);
          // Source records must be objects; a valid JSON scalar is not a
          // valid trajectory record and must not abort the rest of the file.
          if (value && typeof value === 'object' && !Array.isArray(value)) parsed = { value };
          else diagnostic(diagnostics, 'malformedLines');
        }
        catch { diagnostic(diagnostics, atEof ? 'pendingLines' : 'malformedLines'); }
      }
    }
    parts = [];
    lineBytes = 0;
    oversized = false;
    return parsed;
  };
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      diagnostic(diagnostics, 'bytesRead', bytes);
      let start = 0;
      while (start < bytes) {
        const newline = chunk.indexOf(10, start);
        const end = newline >= 0 && newline < bytes ? newline : bytes;
        if (!oversized) {
          lineBytes += end - start;
          if (lineBytes > maxLineBytes) {
            oversized = true;
            parts = [];
          } else if (end > start) parts.push(Buffer.from(chunk.subarray(start, end)));
        }
        if (end === bytes) break;
        const parsed = finishLine();
        if (parsed) yield parsed.value;
        start = end + 1;
      }
    }
    if (lineBytes || oversized) {
      const parsed = finishLine(true);
      if (parsed) yield parsed.value;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Usage accounting needs tool identity/timing, not megabytes of tool content.
// Keep ordinary content unchanged and report any content-only truncation.
function boundedToolContent(value, diagnostics) {
  const limit = 16 * 1024;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  if (serialized.length <= limit) return value;
  diagnostic(diagnostics, 'contentTruncations');
  return typeof value === 'string'
    ? value.slice(0, limit) + '\n[Content truncated; usage metadata retained.]'
    : { contentTruncated: true };
}

function addToolCall(session, pending, ts, { id, name, args }) {
  const ev = { kind: 'tool', ts, tool: { id: id ?? null, name, args: args ?? {}, result: null, isError: false, resultTs: null } };
  session.stats.toolCounts[name] = (session.stats.toolCounts[name] || 0) + 1;
  session.events.push(ev);
  if (id) pending.set(id, ev);
  if (SPAWN_TOOL_RE.test(name)) {
    for (const u of JSON.stringify(args ?? {}).match(UUID_RE) ?? []) session.spawnCandidates.push({ uuid: u.toLowerCase(), ev });
  }
  return ev;
}

function attachResult(session, pending, callId, text, isError, ts) {
  const ev = callId && pending.get(callId);
  if (ev) {
    ev.tool.result = text;
    ev.tool.isError = Boolean(isError);
    ev.tool.resultTs = ts;
    if (SPAWN_TOOL_RE.test(ev.tool.name)) {
      for (const u of (text ?? '').match(UUID_RE) ?? []) session.spawnCandidates.push({ uuid: u.toLowerCase(), ev });
    }
  }
  if (isError) session.stats.errors++;
}

function touch(session, ts) {
  if (!ts) return;
  session.startedAt ??= ts;
  session.endedAt = ts;
}

function finalizeLabel(session) {
  if (!session.label) {
    const first = session.events.find((e) => e.kind === 'user' || e.kind === 'assistant');
    session.label = first ? first.text.slice(0, 100) : '(empty session)';
  }
}

function discoveryError(file, error, diagnostics) {
  // Missing default stores and files disappearing during a scan are normal.
  if (!diagnostics || error?.code === 'ENOENT') return;
  (diagnostics.issues ??= []).push({ file, kind: 'scan-error', message: error?.message ?? String(error) });
}

function safeReaddir(dir, { diagnostics } = {}) {
  try { return fs.readdirSync(dir); }
  catch (error) { discoveryError(dir, error, diagnostics); return []; }
}

function* walkJsonl(dir, depth = 4, options) {
  for (const name of safeReaddir(dir, options)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); }
    catch (error) { discoveryError(p, error, options?.diagnostics); continue; }
    if (st.isDirectory() && depth > 0) yield* walkJsonl(p, depth - 1, options);
    else if (st.isFile() && name.endsWith('.jsonl')) yield p;
  }
}

// ── OpenClaw (also the generic/tolerant parser reused by hermes) ─────────────
function parseGenericMessage(session, pending, obj) {
  const m = obj.message ?? (obj.role ? obj : null);
  if (!m) {
    if (obj.type && obj.type !== 'session') session.events.push({ kind: 'meta', ts: obj.timestamp ?? null, text: obj.type });
    return;
  }
  const ts = obj.timestamp ?? m.timestamp ?? null;
  touch(session, ts);
  const role = m.role;

  if (role === 'assistant') {
    session.stats.messages++;
    if (m.model) session.model = m.model;
    sumUsage(session.stats, m.usage);
    for (const b of blocksOf(m.content)) {
      const t = b.type ?? 'text';
      if (t === 'thinking' || t === 'redacted_thinking') session.events.push({ kind: 'thinking', ts, text: b.thinking ?? b.text ?? '' });
      else if (t === 'text') { if (b.text) session.events.push({ kind: 'assistant', ts, text: b.text }); }
      else if (t === 'toolCall' || t === 'tool_use' || t === 'toolUse')
        addToolCall(session, pending, ts, { id: b.id ?? b.toolCallId, name: b.name ?? b.toolName ?? 'tool', args: b.arguments ?? b.input });
    }
  } else if (role === 'toolResult' || role === 'tool') {
    attachResult(session, pending, m.toolCallId ?? m.tool_call_id ?? m.id, textOf(m.content ?? m.output ?? m.result ?? ''), m.isError ?? m.is_error, ts);
  } else if (role === 'user') {
    const blocks = blocksOf(m.content);
    const results = blocks.filter((b) => b.type === 'tool_result' || b.type === 'toolResult');
    if (results.length) {
      for (const b of results) attachResult(session, pending, b.tool_use_id ?? b.toolCallId, textOf(b.content ?? ''), b.is_error ?? b.isError, ts);
    }
    const text = blocks.filter((b) => (b.type ?? 'text') === 'text').map((b) => b.text ?? '').filter(Boolean).join('\n');
    if (text && !text.startsWith('<')) {
      session.stats.messages++;
      session.events.push({ kind: 'user', ts, text });
      if (!session.label) session.label = text.slice(0, 100);
    }
  }
}

function parseOpenclawFile(source, file, agent, options) {
  const session = newSession(source, file, agent);
  const pending = new Map();
  for (const obj of jsonLines(file, options)) {
    if (obj.type === 'session') {
      if (obj.id) session.id = obj.id;
      touch(session, obj.timestamp);
      continue;
    }
    parseGenericMessage(session, pending, obj);
  }
  finalizeLabel(session);
  return session.events.length ? [session] : [];
}

function openclawAdapter(explicitDir) {
  const roots = explicitDir
    ? [path.resolve(explicitDir)]
    : [path.join(os.homedir(), '.openclaw'), path.join(os.homedir(), '.clawdbot'), path.join(os.homedir(), '.moltbot')];
  return {
    source: 'openclaw',
    findFiles(options) {
      const found = [];
      for (const root of roots) {
        const agentsDir = path.join(root, 'agents');
        for (const agent of safeReaddir(agentsDir, options)) {
          for (const f of safeReaddir(path.join(agentsDir, agent, 'sessions'), options)) {
            if (f.endsWith('.jsonl')) found.push({ file: path.join(agentsDir, agent, 'sessions', f), agent });
          }
        }
        for (const f of safeReaddir(path.join(root, 'sessions'), options)) {
          if (f.endsWith('.jsonl')) found.push({ file: path.join(root, 'sessions', f), agent: 'default' });
        }
      }
      return found;
    },
    parseFile: ({ file, agent }, options) => parseOpenclawFile('openclaw', file, agent, options),
  };
}

// ── Claude Code (~/.claude/projects/<munged-cwd>/<sessionId>.jsonl) ──────────
const CC_SKIP_TYPES = new Set([
  'attachment', 'file-history-snapshot', 'file-history-delta', 'last-prompt',
  'mode', 'permission-mode', 'progress', 'queued-prompt',
]);

function ccParseMessageInto(session, pending, obj) {
  const ts = obj.timestamp ?? null;
  touch(session, ts);
  if (obj.type === 'system') {
    if (!obj.isMeta) session.events.push({ kind: 'meta', ts, text: obj.subtype ?? 'system' });
    return;
  }
  if (obj.isMeta) return;
  parseGenericMessage(session, pending, obj);
}

function parseClaudeCodeFile(file, projectDir, options) {
  const lines = jsonLines(file, options);
  const main = newSession('claude-code', file, projectDir);
  const pendingMain = new Map();
  let title = null;
  const sidechainLines = [];

  for (const obj of lines) {
    if (obj.cwd && main.agent === projectDir) main.agent = path.basename(obj.cwd);
    if (obj.type === 'ai-title' && obj.aiTitle) { title = obj.aiTitle; continue; }
    if (obj.type === 'summary' && obj.summary) { title ??= obj.summary; continue; }
    if (CC_SKIP_TYPES.has(obj.type)) continue;
    if (obj.isSidechain) { sidechainLines.push(obj); continue; }
    if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'system') ccParseMessageInto(main, pendingMain, obj);
  }
  if (title) main.label = title;
  finalizeLabel(main);

  // Sidechains = Task sub-agent transcripts stored in the same file. Group the
  // sidechain entries into chains by walking parentUuid to each chain's root.
  const byUuid = new Map(sidechainLines.map((o) => [o.uuid, o]));
  const rootOf = (o, seen = new Set()) => {
    while (o.parentUuid && byUuid.has(o.parentUuid) && !seen.has(o.uuid)) { seen.add(o.uuid); o = byUuid.get(o.parentUuid); }
    return o.uuid;
  };
  const chains = new Map();
  for (const o of sidechainLines) {
    const r = rootOf(o);
    if (!chains.has(r)) chains.set(r, []);
    chains.get(r).push(o);
  }
  const sessions = [main];
  let i = 0;
  for (const [, chain] of chains) {
    const child = newSession('claude-code', file, main.agent);
    child.id = `${main.id}-sub${i++}`;
    child.parent = main.id;
    const pending = new Map();
    for (const obj of chain) ccParseMessageInto(child, pending, obj);
    if (!child.events.length) continue;
    if (!child.label) child.label = '(sub-agent)';
    main.children.push(child.id);
    sessions.push(child);
    // link the Task/Agent tool call whose prompt matches this chain's first user text
    const firstUser = child.events.find((e) => e.kind === 'user')?.text ?? '';
    for (const ev of main.events) {
      if (ev.kind !== 'tool' || ev.tool.spawnTarget || !SPAWN_TOOL_RE.test(ev.tool.name)) continue;
      const prompt = ev.tool.args?.prompt ?? '';
      if (prompt && firstUser && (prompt.startsWith(firstUser.slice(0, 60)) || firstUser.startsWith(prompt.slice(0, 60)))) {
        ev.tool.spawnTarget = child.id;
        break;
      }
    }
  }
  return main.events.length ? sessions : [];
}

function claudeCodeAdapter() {
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(os.homedir(), '.claude', 'projects');
  return {
    source: 'claude-code',
    findFiles(options) {
      const found = [];
      for (const proj of safeReaddir(root, options)) {
        const dir = path.join(root, proj);
        for (const f of walkJsonl(dir, 2, options)) found.push({ file: f, agent: proj });
      }
      return found;
    },
    parseFile: ({ file, agent }, options) => parseClaudeCodeFile(file, agent, options),
  };
}

// ── Codex CLI (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ─────────────────
export function parseCodexLastTokenUsage(usage, { ts = null, model = null, contextWindowTokens = null } = {}) {
  if (!usage || typeof usage !== 'object') return null;
  const totalInput = count(usage.input_tokens ?? usage.inputTokens);
  const tokensCacheRead = Math.min(totalInput, count(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.tokensCacheRead));
  const tokensCacheWrite = Math.min(totalInput - tokensCacheRead, count(usage.cache_creation_input_tokens ?? usage.tokensCacheWrite));
  const totalOutput = count(usage.output_tokens ?? usage.outputTokens);
  const tokensReasoning = Math.min(totalOutput, count(usage.reasoning_output_tokens ?? usage.tokensReasoning));
  const tokensIn = totalInput - tokensCacheRead - tokensCacheWrite;
  const tokensOut = totalOutput - tokensReasoning;
  return {
    ts: timestamp(ts),
    source: 'codex',
    provider: 'openai',
    model: model ?? null,
    tokensIn,
    tokensOut,
    tokensReasoning,
    tokensCacheRead,
    tokensCacheWrite,
    total: tokensIn + tokensOut + tokensReasoning + tokensCacheRead + tokensCacheWrite,
    costUsd: null,
    contextWindowTokens: nullableNumber(contextWindowTokens),
  };
}

export function parseCodexRateLimits(rateLimits, { ts = null } = {}) {
  if (!rateLimits || typeof rateLimits !== 'object') return [];
  const out = [];
  const eventTimestamp = timestamp(ts);
  const eventSeconds = eventTimestamp ? Date.parse(eventTimestamp) / 1000 : Date.now() / 1000;
  const baseLimitId = rateLimits.limit_id ?? rateLimits.limitId ?? 'codex';
  const baseLabel = rateLimits.limit_name ?? rateLimits.limitName ?? 'Codex';
  for (const window of ['primary', 'secondary']) {
    const raw = rateLimits[window];
    if (!raw || typeof raw !== 'object') continue;
    const usedPercent = nullableNumber(raw.used_percent ?? raw.usedPercent);
    const resetsInSeconds = nullableNumber(raw.resets_in_seconds ?? raw.resetsInSeconds);
    const resetsAt = raw.resets_at ?? raw.resetsAt ?? (
      resetsInSeconds === null ? null : eventSeconds + resetsInSeconds
    );
    out.push({
      ts: eventTimestamp,
      source: 'codex',
      provider: 'openai',
      limitId: `${baseLimitId}:${window}`,
      limitName: baseLabel,
      label: `${baseLabel} ${window}`,
      planType: rateLimits.plan_type ?? rateLimits.planType ?? null,
      window,
      usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      windowMinutes: nullableNumber(raw.window_minutes ?? raw.windowDurationMins ?? raw.windowMinutes),
      resetsAt: timestamp(resetsAt),
    });
  }
  return out;
}

export function parseCodexTokenCount(payload, { ts = null, model = null } = {}) {
  const info = payload?.info ?? null;
  return {
    usageEvent: parseCodexLastTokenUsage(info?.last_token_usage, {
      ts,
      model,
      contextWindowTokens: info?.model_context_window,
    }),
    limitSnapshots: parseCodexRateLimits(payload?.rate_limits, { ts }),
    totalTokenUsage: info?.total_token_usage ?? null,
  };
}

function tokenUsageSignature(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return ['input_tokens', 'cached_input_tokens', 'cache_creation_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
    .map((key) => count(usage[key]))
    .join(':');
}

export function parseCodexFile(file, options = {}) {
  const session = newSession('codex', file, 'codex');
  session.provider = 'openai';
  const m = /rollout-.*?([0-9a-f-]{36})\.jsonl$/i.exec(path.basename(file));
  if (m) session.id = m[1];
  const pending = new Map();
  const lastLimitSignature = new Map();
  let lastTotalSignature = null;
  let lastUsageSignature = null;

  for (const obj of jsonLines(file, options)) {
    const ts = obj.timestamp ?? null;
    const p = obj.payload ?? obj; // older codex versions have no payload wrapper
    const type = p.type ?? obj.type;

    if (obj.type === 'session_meta') {
      if (p.id) session.id = p.id;
      if (p.cwd) session.agent = path.basename(p.cwd);
      touch(session, p.timestamp ?? ts);
      continue;
    }
    if (obj.type === 'turn_context' || type === 'turn_context') {
      if (p.model) session.model = p.model;
      continue;
    }
    if (obj.type === 'compacted') {
      session.events.push({ kind: 'meta', ts, text: 'context compacted' });
      touch(session, ts);
      continue;
    }
    if (obj.type === 'event_msg') {
      if (type === 'token_count') {
        const parsed = parseCodexTokenCount(p, { ts, model: session.model });
        const totalSignature = tokenUsageSignature(parsed.totalTokenUsage);
        const lastUsage = tokenUsageSignature(p.info?.last_token_usage);
        // Equal-sized calls can be independent when cumulative counters are
        // unavailable. Only suppress the same timestamp/model/usage record.
        const usageSignature = lastUsage && JSON.stringify([ts, session.model, p.id ?? p.event_id ?? null, lastUsage]);
        const advanced = totalSignature
          ? totalSignature !== lastTotalSignature
          : usageSignature && usageSignature !== lastUsageSignature;
        if (parsed.usageEvent && advanced) {
          session.usageEvents.push(parsed.usageEvent);
          if (totalSignature) lastTotalSignature = totalSignature;
          if (usageSignature) lastUsageSignature = usageSignature;
        }

        for (const snapshot of parsed.limitSnapshots) {
          const signature = [snapshot.limitId, snapshot.planType, snapshot.usedPercent, snapshot.windowMinutes, snapshot.resetsAt].join(':');
          if (lastLimitSignature.get(snapshot.window) === signature) continue;
          lastLimitSignature.set(snapshot.window, signature);
          session.limitSnapshots.push(snapshot);
        }

        if (parsed.totalTokenUsage) {
          const u = parsed.totalTokenUsage;
          session.stats.tokensIn = count(u.input_tokens);
          session.stats.tokensOut = count(u.output_tokens);
          session.stats.tokensCacheRead = count(u.cached_input_tokens);
          session.stats.tokensCacheWrite = count(u.cache_creation_input_tokens);
        }
      }
      continue; // messages/tool activity are taken from response_item lines
    }
    if (obj.type !== 'response_item' && obj.type !== undefined && !p.role && !type) continue;

    touch(session, ts);
    if (type === 'message') {
      // Usage monitoring does not need prompt or response bodies. Keep only a
      // timing marker so trajectory metrics work without returning raw text.
      if (p.role === 'user') {
        session.stats.messages++;
        session.events.push({ kind: 'user', ts, text: 'Content withheld for privacy.' });
      } else if (p.role === 'assistant') {
        session.stats.messages++;
        session.events.push({ kind: 'assistant', ts, text: 'Content withheld for privacy.' });
      }
    } else if (type === 'reasoning') {
      session.events.push({ kind: 'thinking', ts, text: 'Reasoning content withheld for privacy.' });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      let args = p.arguments ?? p.input ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { input: args }; } }
      addToolCall(session, pending, ts, { id: p.call_id ?? p.id, name: p.name ?? 'tool', args: boundedToolContent(args, options.diagnostics) });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      let out = p.output ?? '';
      if (typeof out === 'string' && out.startsWith('{')) { try { out = JSON.parse(out).output ?? out; } catch { /* keep */ } }
      const isError = /(?:exited with code (?!0\b)\d+|process exited with code (?!0\b)\d+|script (?:failed|error))/i.test(String(out).slice(0, 500));
      attachResult(session, pending, p.call_id ?? p.id, boundedToolContent(String(out), options.diagnostics), isError, ts);
    } else if (type === 'web_search_call') {
      addToolCall(session, pending, ts, { id: p.id, name: 'web_search', args: boundedToolContent(p.action ?? {}, options.diagnostics) });
    }
  }
  session.label = `Codex · ${session.model ?? session.agent ?? 'session'} · ${session.id.slice(0, 8)}`;
  return session.events.length || session.usageEvents.length || session.limitSnapshots.length ? [session] : [];
}

function codexAdapter() {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
  return {
    source: 'codex',
    findFiles: (options) => [...walkJsonl(root, 4, options)].map((file) => ({ file, agent: 'codex' })),
    parseFile: ({ file }, options) => parseCodexFile(file, options),
  };
}

// ── OpenCode (~/.local/share/opencode/opencode.db) ───────────────────────────
function isFile(file, { diagnostics } = {}) {
  try { return fs.statSync(file).isFile(); }
  catch (error) { discoveryError(file, error, diagnostics); return false; }
}

export function discoverOpenCodeDatabase({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (env.OPENCODE_DB?.trim()) return path.resolve(env.OPENCODE_DB.trim());
  const candidates = [];
  if (env.XDG_DATA_HOME?.trim()) candidates.push(path.resolve(env.XDG_DATA_HOME.trim(), 'opencode', 'opencode.db'));
  candidates.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  if (platform === 'darwin') candidates.push(path.join(home, 'Library', 'Application Support', 'opencode', 'opencode.db'));
  if (platform === 'win32' && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'opencode', 'opencode.db'));
  return candidates.find(isFile) ?? candidates[0];
}

export function sqliteFingerprint(file) {
  return ['', '-wal', '-shm'].map((suffix) => {
    try {
      const stat = fs.statSync(file + suffix);
      return `${suffix || 'db'}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${suffix || 'db'}:missing`;
    }
  }).join('|');
}

function sqliteModule() {
  try { return require('node:sqlite'); }
  catch (error) {
    throw new Error(`OpenCode ingestion requires the built-in node:sqlite module (Node.js 22.5+): ${error.message}`, { cause: error });
  }
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
}

function optionalColumn(columns, name, alias = name, table = '') {
  return columns.has(name) ? `${table}"${name}" AS "${alias}"` : `NULL AS "${alias}"`;
}

function requireOpenCodeSchema(db, file) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('session', 'message', 'part')").all().map((row) => row.name));
  const missing = ['session', 'message'].filter((name) => !tables.has(name));
  if (missing.length) throw new Error(`OpenCode database schema at ${file} is incompatible (missing table${missing.length > 1 ? 's' : ''}: ${missing.join(', ')})`);
  const session = tableColumns(db, 'session');
  const message = tableColumns(db, 'message');
  if (!session.has('id')) throw new Error(`OpenCode database schema at ${file} is incompatible (session.id is required)`);
  const missingMessage = ['session_id', 'data'].filter((name) => !message.has(name));
  if (missingMessage.length) throw new Error(`OpenCode database schema at ${file} is incompatible (message.${missingMessage.join(' and message.')} required)`);
  const json = db.prepare("SELECT json_valid('{}') AS ok").get();
  if (!json?.ok) throw new Error(`OpenCode database at ${file} does not provide SQLite JSON functions`);
  return { session, message, part: tables.has('part') ? tableColumns(db, 'part') : null };
}

function openCodeUsageEvent(row, ts) {
  const tokensIn = count(row.tokens_input);
  const tokensOut = count(row.tokens_output);
  const tokensReasoning = count(row.tokens_reasoning);
  const tokensCacheRead = count(row.tokens_cache_read);
  const tokensCacheWrite = count(row.tokens_cache_write);
  return {
    ...(row.message_id == null ? {} : { id: String(row.message_id) }),
    ts,
    source: 'opencode',
    provider: row.provider_id ?? null,
    model: row.model_id ?? null,
    tokensIn,
    tokensOut,
    tokensReasoning,
    tokensCacheRead,
    tokensCacheWrite,
    total: tokensIn + tokensOut + tokensReasoning + tokensCacheRead + tokensCacheWrite,
    costUsd: nullableNumber(row.cost),
    contextWindowTokens: null,
  };
}

export function parseOpenCodeDatabase(file, options = {}) {
  const { DatabaseSync } = sqliteModule();
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const schema = requireOpenCodeSchema(db, file);
    const sessionFields = [
      optionalColumn(schema.session, 'id'),
      optionalColumn(schema.session, 'parent_id'),
      optionalColumn(schema.session, 'directory'),
      optionalColumn(schema.session, 'title'),
      optionalColumn(schema.session, 'summary_additions'),
      optionalColumn(schema.session, 'summary_deletions'),
      optionalColumn(schema.session, 'summary_files'),
      optionalColumn(schema.session, 'time_created'),
      optionalColumn(schema.session, 'time_updated'),
    ];
    const rows = db.prepare(`SELECT ${sessionFields.join(', ')} FROM "session"`).all();
    const sessions = new Map();
    for (const row of rows) {
      const directory = typeof row.directory === 'string' ? row.directory : '';
      const session = newSession('opencode', file, path.basename(directory) || 'opencode');
      session.id = String(row.id);
      session.parent = row.parent_id == null ? null : String(row.parent_id);
      session.label = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : '(OpenCode session)';
      session.startedAt = timestamp(row.time_created);
      session.endedAt = timestamp(row.time_updated ?? row.time_created);
      if ([row.summary_additions, row.summary_deletions, row.summary_files].some((value) => value != null)) {
        session.summary = {
          additions: count(row.summary_additions),
          deletions: count(row.summary_deletions),
          files: count(row.summary_files),
        };
      }
      sessions.set(session.id, session);
    }

    const messageFields = [
      '"session_id" AS "session_id"',
      optionalColumn(schema.message, 'id', 'message_id'),
      optionalColumn(schema.message, 'time_created'),
      "json_extract(data, '$.time.created') AS data_created",
      "json_extract(data, '$.time.completed') AS data_completed",
      "json_extract(data, '$.providerID') AS provider_id",
      "json_extract(data, '$.modelID') AS model_id",
      "json_extract(data, '$.cost') AS cost",
      "json_extract(data, '$.tokens.input') AS tokens_input",
      "json_extract(data, '$.tokens.output') AS tokens_output",
      "json_extract(data, '$.tokens.reasoning') AS tokens_reasoning",
      "json_extract(data, '$.tokens.cache.read') AS tokens_cache_read",
      "json_extract(data, '$.tokens.cache.write') AS tokens_cache_write",
    ];
    const assistantRows = db.prepare(`
      SELECT ${messageFields.join(', ')}
      FROM "message"
      WHERE json_valid(data) AND json_extract(data, '$.role') = 'assistant'
      ORDER BY session_id, time_created, message_id
    `).all();
    for (const row of assistantRows) {
      const session = sessions.get(String(row.session_id));
      if (!session) continue;
      const ts = timestamp(row.data_completed ?? row.data_created ?? row.time_created);
      const usage = openCodeUsageEvent(row, ts);
      session.usageEvents.push(usage);
      session.model = usage.model ?? session.model;
      session.provider = usage.provider ?? session.provider ?? null;
      session.stats.tokensIn += usage.tokensIn + usage.tokensCacheRead + usage.tokensCacheWrite;
      session.stats.tokensOut += usage.tokensOut + usage.tokensReasoning;
      session.stats.tokensCacheRead += usage.tokensCacheRead;
      session.stats.tokensCacheWrite += usage.tokensCacheWrite;
      if (ts) {
        session.startedAt ??= ts;
        if (!session.endedAt || Date.parse(ts) > Date.parse(session.endedAt)) session.endedAt = ts;
      }
    }

    const messageCounts = db.prepare(`
      SELECT session_id, COUNT(*) AS messages
      FROM "message"
      GROUP BY session_id
    `).all();
    for (const row of messageCounts) {
      const session = sessions.get(String(row.session_id));
      if (session) session.stats.messages = count(row.messages);
    }

    const part = schema.part;
    if (part?.has('data') && part.has('message_id') && (part.has('session_id') || schema.message.has('id'))) {
      const joinMessage = part.has('session_id') ? '' : 'JOIN "message" m ON m."id" = p."message_id"';
      const sessionId = part.has('session_id') ? 'p."session_id"' : 'm."session_id"';
      const partFields = [
        `${sessionId} AS session_id`,
        optionalColumn(part, 'id', 'part_id', 'p.'),
        optionalColumn(part, 'time_created', 'time_created', 'p.'),
        "json_extract(p.data, '$.tool') AS tool_name",
        "json_extract(p.data, '$.callID') AS call_id",
        "json_extract(p.data, '$.state.status') AS status",
        "json_extract(p.data, '$.state.time.start') AS tool_started",
        "json_extract(p.data, '$.state.time.end') AS tool_ended",
      ];
      const toolRows = db.prepare(`
        SELECT ${partFields.join(', ')}
        FROM "part" p ${joinMessage}
        WHERE json_valid(p.data) AND json_extract(p.data, '$.type') = 'tool'
        ORDER BY session_id, time_created, part_id
      `).all();
      for (const row of toolRows) {
        const session = sessions.get(String(row.session_id));
        if (!session) continue;
        const started = timestamp(row.tool_started ?? row.time_created);
        const ended = timestamp(row.tool_ended);
        const name = typeof row.tool_name === 'string' && row.tool_name ? row.tool_name : 'tool';
        const event = addToolCall(session, new Map(), started, { id: row.call_id ?? row.part_id, name, args: {} });
        event.tool.isError = row.status === 'error';
        event.tool.resultTs = ended;
        if (event.tool.isError) session.stats.errors++;
        if (started) {
          session.startedAt ??= started;
          const last = ended ?? started;
          if (!session.endedAt || Date.parse(last) > Date.parse(session.endedAt)) session.endedAt = last;
        }
      }
    }

    for (const session of sessions.values()) {
      if (session.parent && sessions.has(session.parent)) sessions.get(session.parent).children.push(session.id);
    }
    return [...sessions.values()];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('OpenCode ')) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenCode database read failed at ${file}: ${message}`, { cause: error });
  } finally {
    try { db?.close(); } catch { /* keep the original diagnostic */ }
  }
}

export function opencodeAdapter() {
  return {
    source: 'opencode',
    findFiles(options) {
      const file = discoverOpenCodeDatabase();
      return isFile(file, options) ? [{ file, agent: 'opencode' }] : [];
    },
    fingerprint: ({ file }) => sqliteFingerprint(file),
    parseFile: ({ file }, options) => parseOpenCodeDatabase(file, options),
  };
}

// ── Hermes (best-effort generic: HERMES_STATE_DIR or ~/.hermes) ──────────────
function hermesAdapter() {
  const root = process.env.HERMES_STATE_DIR ?? path.join(os.homedir(), '.hermes');
  return {
    source: 'hermes',
    findFiles: (options) => [...walkJsonl(root, 4, options)].map((file) => ({ file, agent: path.basename(path.dirname(file)) })),
    parseFile: ({ file, agent }, options) => parseOpenclawFile('hermes', file, agent, options),
  };
}

export function makeAdapters({ explicitDir = null, sources = null } = {}) {
  // An explicit --dir points at an OpenClaw-layout state dir and disables the
  // other sources so demos/exports aren't mixed with local history.
  const all = explicitDir
    ? [openclawAdapter(explicitDir)]
    : [openclawAdapter(null), claudeCodeAdapter(), codexAdapter(), opencodeAdapter(), hermesAdapter()];
  return sources ? all.filter((a) => sources.includes(a.source)) : all;
}
