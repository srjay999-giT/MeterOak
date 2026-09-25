import path from 'node:path';

export const EDIT_TOOLS = new Set([
  'edit', 'write', 'notebookedit', 'multiedit', 'str_replace_editor', 'apply_patch',
]);

const CORRECTION_RE = /(?:^|\b)(?:no[,—:]?|nope|wrong|incorrect|not what i|that(?:'s| is) not|you (?:missed|ignored|changed)|actually[,—:]?|instead[,—:]?|stop[,—:]?|undo|revert|go back|don(?:'t| not)|i said|please fix that)(?:\b|$)/i;

export const dayKey = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const lineCount = (value) => {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const normalized = value.replace(/\r\n/g, '\n');
  const count = normalized.split('\n').length;
  return normalized.endsWith('\n') ? count - 1 : count;
};

function cleanFilePath(value) {
  if (typeof value !== 'string') return null;
  let out = value.trim().replace(/^['"]|['"]$/g, '').replaceAll('\\', '/');
  out = out.replace(/^[ab]\//, '');
  return out && out !== '/dev/null' ? out : null;
}

function patchTextFrom(args) {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object') return '';
  for (const key of ['patch', 'input', 'cmd', 'command']) {
    if (typeof args[key] === 'string' && (args[key].includes('*** Begin Patch') || args[key].includes('diff --git '))) {
      let text = args[key];
      // Newer Codex wrappers can carry apply_patch inside a JavaScript string.
      if (!/^\*\*\* (?:Add|Update|Delete) File:/m.test(text)) text = decodeWrappedPatch(text);
      return text;
    }
  }
  return '';
}

function decodeWrappedPatch(source) {
  const marker = source.indexOf('*** Begin Patch');
  if (marker <= 0) return source;
  const quote = source[marker - 1];
  if (!['"', "'", '`'].includes(quote)) return source;
  let end = marker;
  while (end < source.length) {
    end = source.indexOf(quote, end + 1);
    if (end < 0) return source;
    let slashes = 0;
    for (let i = end - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
    if (slashes % 2 === 0) break;
  }
  const encoded = source.slice(marker, end);
  if (quote === '"') {
    try { return JSON.parse(`"${encoded}"`); } catch { /* use tolerant decoder */ }
  }
  let out = '';
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== '\\' || i === encoded.length - 1) { out += encoded[i]; continue; }
    const next = encoded[++i];
    out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
  }
  return out;
}

/** Parse Codex apply_patch and ordinary unified diff bodies into per-file deltas. */
export function parsePatch(patch) {
  if (typeof patch !== 'string' || !patch) return [];
  const records = new Map();
  let current = null;
  const get = (p) => {
    p = cleanFilePath(p);
    if (!p) return null;
    if (!records.has(p)) records.set(p, { path: p, additions: 0, deletions: 0 });
    return records.get(p);
  };

  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    let m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) { current = get(m[1]); continue; }
    m = /^\*\*\* Move to: (.+)$/.exec(line);
    if (m) { current = get(m[1]); continue; }
    m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { current = get(m[2]); continue; }
    m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') { current = get(m[1]); continue; }
    if (!current || /^\+\+\+|^---/.test(line)) continue;
    if (line.startsWith('+')) current.additions++;
    else if (line.startsWith('-')) current.deletions++;
  }
  return [...records.values()];
}

function stringEdit(pathValue, oldValue, newValue) {
  const p = cleanFilePath(pathValue);
  if (!p) return [];
  return [{ path: p, additions: lineCount(newValue), deletions: lineCount(oldValue) }];
}

/** Normalize Edit/Write/NotebookEdit/str_replace_editor/apply_patch calls. */
export function extractEditOperations(ev) {
  if (ev?.kind !== 'tool') return [];
  const name = String(ev.tool?.name ?? '').toLowerCase();
  const args = ev.tool?.args ?? {};
  const patch = patchTextFrom(args);
  if (patch) return parsePatch(patch);
  if (!EDIT_TOOLS.has(name)) return [];

  const p = args.file_path ?? args.path ?? args.notebook_path ?? args.file;
  if (name === 'multiedit' || Array.isArray(args.edits)) {
    return (args.edits ?? []).flatMap((edit) => stringEdit(p, edit.old_string ?? edit.old_str ?? '', edit.new_string ?? edit.new_str ?? ''));
  }
  if (name === 'write') return stringEdit(p, '', args.content ?? args.file_text ?? args.text ?? '');
  if (name === 'notebookedit') return stringEdit(p, args.old_source ?? '', args.new_source ?? args.new_source ?? args.source ?? '');
  if (name === 'str_replace_editor') {
    const command = String(args.command ?? '').toLowerCase();
    if (command === 'create') return stringEdit(p, '', args.file_text ?? args.new_str ?? '');
    if (command === 'insert') return stringEdit(p, '', args.new_str ?? args.text ?? '');
    return stringEdit(p, args.old_str ?? args.old_string ?? '', args.new_str ?? args.new_string ?? '');
  }
  return stringEdit(p, args.old_string ?? args.old_str ?? '', args.new_string ?? args.new_str ?? args.content ?? '');
}

function rateFor(model, source, pricing) {
  if (!pricing?.models?.length) return null;
  const value = String(model ?? '');
  for (const rate of pricing.models) {
    if (rate.source && rate.source !== source) continue;
    try {
      if (new RegExp(rate.pattern, 'i').test(value)) return rate;
    } catch { /* tolerate a bad custom pricing row */ }
  }
  return null;
}

export function priceSession(session, pricing) {
  const tokens = emptyTokens();
  const costs = emptyCost();
  const rates = new Map();
  const models = new Set();
  for (const event of normalizedUsageEvents(session)) {
    const cost = usageEventCost(event, pricing);
    addTokens(tokens, event.tokens);
    addCost(costs, cost);
    models.add(event.model);
    if (cost.rate) rates.set(cost.rate.id, cost.rate);
  }
  const cost = finalizedCost(costs);
  return {
    ...cost,
    total: cost.usd,
    rate: models.size === 1 && rates.size === 1 ? [...rates.values()][0] : null,
    rates: [...rates.values()],
    freshInput: tokens.input,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    output: tokens.output + tokens.reasoning,
  };
}

const nonNegative = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const nullableNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const isoTimestamp = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function usageTokens(event = {}) {
  const tokens = {
    input: nonNegative(event.tokensIn),
    output: nonNegative(event.tokensOut),
    reasoning: nonNegative(event.tokensReasoning),
    cacheRead: nonNegative(event.tokensCacheRead),
    cacheWrite: nonNegative(event.tokensCacheWrite),
  };
  tokens.total = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
  return tokens;
}

function addTokens(target, value) {
  for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total']) target[key] += value[key];
  return target;
}

function normalizedUsageEvents(session) {
  const source = String(session.source || 'unknown');
  const events = Array.isArray(session.usageEvents) && (session.usageEvents.length || session.usageWindowApplied)
    ? session.usageEvents
    : [{
      ts: session.startedAt ?? session.endedAt,
      provider: session.provider,
      model: session.model,
      tokensIn: Math.max(0,
        nonNegative(session.stats?.tokensIn)
        - nonNegative(session.stats?.tokensCacheRead)
        - nonNegative(session.stats?.tokensCacheWrite)),
      tokensOut: session.stats?.tokensOut,
      tokensReasoning: 0,
      tokensCacheRead: session.stats?.tokensCacheRead,
      tokensCacheWrite: session.stats?.tokensCacheWrite,
      synthetic: true,
    }];

  return events.map((event) => ({
    sessionId: session.id,
    source,
    provider: String(event.provider ?? session.provider ?? source),
    // An explicitly unknown per-request model must not inherit the model
    // selected later in a mixed-model session or receive its price.
    model: String(Object.hasOwn(event, 'model')
      ? event.model ?? '(unknown model)'
      : session.model ?? '(unknown model)'),
    ts: isoTimestamp(event.ts ?? session.startedAt ?? session.endedAt),
    tokens: usageTokens(event),
    costUsd: nullableNumber(event.costUsd),
    costOrigin: event.costOrigin,
    synthetic: Boolean(event.synthetic),
  }));
}

function publicRate(rate) {
  return rate ? {
    id: rate.id, label: rate.label, input: rate.input, output: rate.output,
    cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite,
    serviceTier: rate.serviceTier ?? null,
    verifiedAt: rate.verifiedAt ?? null,
    sourceUrl: rate.sourceUrl ?? null,
    longContext: rate.longContext ? { ...rate.longContext } : null,
  } : null;
}

function usageEventCost(event, pricing) {
  const rate = rateFor(event.model, event.source, pricing);
  const visibleRate = publicRate(rate);
  if (event.costUsd != null && event.costUsd >= 0) {
    return { usd: event.costUsd, origin: event.costOrigin === 'estimated' ? 'estimated' : 'reported', rate: visibleRate };
  }
  if (!rate) return { usd: null, origin: 'unpriced', rate: null };
  const tokens = event.tokens;
  const inputTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const hasContextTier = Number.isFinite(rate.longContext?.thresholdInputTokens);
  // Legacy synthetic records summarize a session, not one request. Keep their
  // baseline estimate and disclose the unknown tier instead of applying a premium.
  const longContext = !event.synthetic && hasContextTier && inputTokens > rate.longContext.thresholdInputTokens;
  const applied = longContext ? rate.longContext : rate;
  const usd = (
    tokens.input * (applied.input || 0)
    + tokens.cacheRead * (applied.cacheRead ?? applied.input ?? 0)
    + tokens.cacheWrite * (applied.cacheWrite ?? applied.input ?? 0)
    + (tokens.output + tokens.reasoning) * (applied.output || 0)
  ) / 1_000_000;
  return { usd, origin: 'estimated', rate: visibleRate, longContext, contextUncertain: Boolean(event.synthetic && hasContextTier) };
}

const emptyCost = () => ({ reportedUsd: 0, estimatedUsd: 0, reportedEvents: 0, estimatedEvents: 0, pricedEvents: 0, unpricedEvents: 0, longContextEvents: 0, contextUncertainEvents: 0 });

function addCost(target, cost) {
  if (cost.longContext) target.longContextEvents++;
  if (cost.contextUncertain) target.contextUncertainEvents++;
  if (cost.usd == null) target.unpricedEvents++;
  else {
    target.pricedEvents++;
    const origin = cost.origin === 'reported' ? 'reported' : 'estimated';
    target[`${origin}Usd`] += cost.usd;
    target[`${origin}Events`]++;
  }
  return target;
}

function finalizedCost(value) {
  const totalEvents = value.pricedEvents + value.unpricedEvents;
  const hasReported = value.reportedEvents > 0;
  const hasEstimated = value.estimatedEvents > 0;
  return {
    usd: value.pricedEvents ? value.reportedUsd + value.estimatedUsd : null,
    reportedUsd: value.reportedUsd,
    estimatedUsd: value.estimatedUsd,
    pricedEvents: value.pricedEvents,
    unpricedEvents: value.unpricedEvents,
    longContextEvents: value.longContextEvents,
    contextUncertainEvents: value.contextUncertainEvents,
    coverage: totalEvents ? value.pricedEvents / totalEvents : 0,
    provenance: !value.pricedEvents ? 'unpriced' : hasReported && hasEstimated ? 'mixed' : hasReported ? 'reported' : 'estimated',
  };
}

const emptyDailyUsage = () => ({ eventCount: 0, tokens: emptyTokens(), cost: emptyCost(), usageSessionIds: new Set() });

function finalizedDay(row) {
  const { usageSessionIds, ...value } = row;
  const cost = finalizedCost(value.cost);
  return {
    ...value,
    sessions: value.sessions ?? usageSessionIds.size,
    usageSessionCount: usageSessionIds.size,
    // A known day with no usage is zero. Active unpriced days remain null.
    cost: value.eventCount ? cost : { ...cost, usd: 0, coverage: null, provenance: 'no-usage' },
  };
}

function normalizeLimitSnapshot(session, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const source = String(session.source || 'unknown');
  const usedPercent = nullableNumber(snapshot.usedPercent);
  const label = String(snapshot.label ?? snapshot.limitId ?? 'Usage limit');
  return {
    source,
    provider: String(snapshot.provider ?? session.provider ?? source),
    limitId: String(snapshot.limitId ?? snapshot.id ?? label),
    label,
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
    windowMinutes: nullableNumber(snapshot.windowMinutes),
    resetsAt: isoTimestamp(snapshot.resetsAt),
    planType: snapshot.planType == null ? null : String(snapshot.planType),
    ts: isoTimestamp(snapshot.ts ?? session.endedAt ?? session.startedAt),
  };
}

const median = (values) => {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

function sessionIntelligence(session, pricing) {
  const files = new Map();
  const edits = [];
  const toolLatencies = [];
  const users = session.events.filter((e) => e.kind === 'user');
  let toolCalls = 0;
  let toolErrors = 0;
  let firstEditAt = null;

  for (const ev of session.events) {
    if (ev.kind !== 'tool') continue;
    toolCalls++;
    if (ev.tool.isError) toolErrors++;
    if (ev.ts && ev.tool.resultTs) {
      const ms = Date.parse(ev.tool.resultTs) - Date.parse(ev.ts);
      if (ms >= 0 && ms < 86_400_000) toolLatencies.push(ms);
    }
    const ops = extractEditOperations(ev);
    if (!ops.length) continue;
    firstEditAt ??= ev.ts;
    for (const op of ops) {
      edits.push({ ...op, ts: ev.ts });
      const rec = files.get(op.path) ?? { path: op.path, additions: 0, deletions: 0, edits: 0 };
      rec.additions += op.additions;
      rec.deletions += op.deletions;
      rec.edits++;
      files.set(op.path, rec);
    }
  }

  const corrections = users.slice(1).filter((e) => CORRECTION_RE.test(e.text ?? '')).length;
  const firstUserAt = users.find((e) => e.ts)?.ts ?? null;
  let timeToFirstEditMs = null;
  if (firstUserAt && firstEditAt) {
    const ms = Date.parse(firstEditAt) - Date.parse(firstUserAt);
    if (ms >= 0 && ms < 86_400_000) timeToFirstEditMs = ms;
  }
  const last = [...session.events].reverse().find((e) => e.kind === 'user' || e.kind === 'assistant' || e.kind === 'tool');
  const isLive = session.endedAt && Date.now() - Date.parse(session.endedAt) < 5 * 60_000;
  const abandoned = Boolean(users.length && last?.kind !== 'assistant' && !isLive);
  const reworkLoops = [...files.values()].reduce((n, f) => n + Math.max(0, f.edits - 1), 0);
  const cost = priceSession(session, pricing);
  return {
    edits,
    files: [...files.values()],
    editOperations: edits.length,
    changedLines: edits.reduce((n, e) => n + e.additions + e.deletions, 0),
    additions: edits.reduce((n, e) => n + e.additions, 0),
    deletions: edits.reduce((n, e) => n + e.deletions, 0),
    reworkLoops,
    corrections,
    abandoned,
    timeToFirstEditMs,
    toolCalls,
    toolErrors,
    toolLatencies,
    medianToolLatencyMs: median(toolLatencies),
    cost,
  };
}

function sourceAggregate(source) {
  return {
    source, sessions: 0, edits: 0, changedLines: 0, outputTokens: 0, inputTokens: 0,
    cacheRead: 0, toolCalls: 0, toolErrors: 0, toolLatencies: [], apiCost: 0,
    pricedSessions: 0, pricedEdits: 0, pricedChangedLines: 0,
    corrections: 0, reworkLoops: 0, abandoned: 0, firstEditTimes: [],
  };
}

function finalizeSource(row) {
  const cacheDenom = Math.max(0, row.inputTokens);
  return {
    source: row.source,
    sessions: row.sessions,
    edits: row.edits,
    changedLines: row.changedLines,
    apiCost: row.apiCost,
    pricedSessions: row.pricedSessions,
    editsPerSession: row.sessions ? row.edits / row.sessions : null,
    outputTokensPerEdit: row.edits ? row.outputTokens / row.edits : null,
    toolErrorRate: row.toolCalls ? row.toolErrors / row.toolCalls : null,
    medianToolLatencyMs: median(row.toolLatencies),
    cacheEfficiency: cacheDenom ? row.cacheRead / cacheDenom : null,
    costPerEdit: row.pricedEdits ? row.apiCost / row.pricedEdits : null,
    costPer100Lines: row.pricedChangedLines ? row.apiCost / row.pricedChangedLines * 100 : null,
    correctionsPerSession: row.sessions ? row.corrections / row.sessions : null,
    reworkPerSession: row.sessions ? row.reworkLoops / row.sessions : null,
    abandonedRate: row.sessions ? row.abandoned / row.sessions : null,
    medianTimeToFirstEditMs: median(row.firstEditTimes),
  };
}

function riskLevel(score) {
  return score >= 65 ? 'high' : score >= 30 ? 'watch' : 'low';
}

export function buildStats(sessions, { days = 30, pricing = null, now = Date.now() } = {}) {
  let today = new Date(now);
  if (Number.isNaN(today.getTime())) today = new Date();
  const nowMs = today.getTime();
  const asOf = today.toISOString();
  const perDay = new Map();
  const day = (k) => {
    if (!k) return null;
    if (!perDay.has(k)) perDay.set(k, { date: k, toolCalls: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensCacheWrite: 0, sessions: 0, errors: 0, additions: 0, deletions: 0, edits: 0, apiCost: 0, ...emptyDailyUsage() });
    return perDay.get(k);
  };
  const punch = Array.from({ length: 7 }, () => Array(24).fill(0));
  const tools = new Map();
  const models = new Map();
  const files = new Map();
  const directories = new Map();
  const sources = new Map();
  const usageRows = [];
  const usageTotals = emptyTokens();
  const usageCost = emptyCost();
  const usageSessions = new Set();
  const limitHistory = [];
  const latestLimits = new Map();
  const totals = {
    sessions: sessions.length, spawns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0,
    cacheRead: 0, cacheWrite: 0, errors: 0, edits: 0, editCalls: 0, messages: 0,
    additions: 0, deletions: 0, changedLines: 0, filesTouched: 0,
  };
  const sessionRows = [];
  let longest = null;
  let firstObservedMs = null;
  let lastObservedMs = null;

  for (const session of sessions) {
    const intel = sessionIntelligence(session, pricing);
    const sessionUsageCost = emptyCost();
    for (const event of normalizedUsageEvents(session)) {
      const cost = usageEventCost(event, pricing);
      const row = { ...event, cost };
      usageRows.push(row);
      usageSessions.add(session.id);
      addTokens(usageTotals, event.tokens);
      addCost(usageCost, cost);
      addCost(sessionUsageCost, cost);

      const eventMs = event.ts ? Date.parse(event.ts) : Number.NaN;
      if (Number.isFinite(eventMs)) {
        firstObservedMs = firstObservedMs == null ? eventMs : Math.min(firstObservedMs, eventMs);
        lastObservedMs = lastObservedMs == null ? eventMs : Math.max(lastObservedMs, eventMs);
      }

      const modelKey = `${event.source}\u0000${event.provider}\u0000${event.model}`;
      const model = models.get(modelKey) ?? {
        source: event.source,
        provider: event.provider,
        model: event.model,
        name: event.model,
        sessionIds: new Set(),
        pricedSessionIds: new Set(),
        eventCount: 0,
        tokens: emptyTokens(),
        cost: emptyCost(),
        days: new Map(),
        rate: null,
      };
      model.sessionIds.add(session.id);
      if (cost.usd != null) model.pricedSessionIds.add(session.id);
      model.eventCount++;
      addTokens(model.tokens, event.tokens);
      addCost(model.cost, cost);
      model.rate ??= cost.rate;
      models.set(modelKey, model);

      const usageDay = day(dayKey(event.ts));
      if (usageDay) {
        usageDay.eventCount++;
        usageDay.usageSessionIds.add(session.id);
        addTokens(usageDay.tokens, event.tokens);
        addCost(usageDay.cost, cost);
        usageDay.tokensIn += event.tokens.input + event.tokens.cacheRead + event.tokens.cacheWrite;
        usageDay.tokensOut += event.tokens.output + event.tokens.reasoning;
        usageDay.tokensCache += event.tokens.cacheRead;
        usageDay.tokensCacheWrite += event.tokens.cacheWrite;
        if (cost.usd != null) usageDay.apiCost += cost.usd;

        const modelDay = model.days.get(usageDay.date) ?? { date: usageDay.date, ...emptyDailyUsage() };
        modelDay.eventCount++;
        modelDay.usageSessionIds.add(session.id);
        addTokens(modelDay.tokens, event.tokens);
        addCost(modelDay.cost, cost);
        model.days.set(usageDay.date, modelDay);
      }
    }
    const normalizedSessionCost = finalizedCost(sessionUsageCost);
    const fullyPricedSession = normalizedSessionCost.pricedEvents > 0 && normalizedSessionCost.unpricedEvents === 0;

    const source = sources.get(session.source) ?? sourceAggregate(session.source);
    sources.set(session.source, source);
    source.sessions++;
    source.edits += intel.editOperations;
    source.changedLines += intel.changedLines;
    source.outputTokens += session.stats.tokensOut || 0;
    source.inputTokens += session.stats.tokensIn || 0;
    source.cacheRead += session.stats.tokensCacheRead || 0;
    source.toolCalls += intel.toolCalls;
    source.toolErrors += intel.toolErrors;
    source.toolLatencies.push(...intel.toolLatencies);
    source.corrections += intel.corrections;
    source.reworkLoops += intel.reworkLoops;
    source.abandoned += Number(intel.abandoned);
    if (intel.timeToFirstEditMs != null) source.firstEditTimes.push(intel.timeToFirstEditMs);
    if (normalizedSessionCost.usd != null) source.apiCost += normalizedSessionCost.usd;
    if (fullyPricedSession) {
      source.pricedSessions++;
      source.pricedEdits += intel.editOperations;
      source.pricedChangedLines += intel.changedLines;
    }

    totals.spawns += session.children?.length || 0;
    totals.tokensIn += session.stats.tokensIn || 0;
    totals.tokensOut += session.stats.tokensOut || 0;
    totals.cacheRead += session.stats.tokensCacheRead || 0;
    totals.cacheWrite += session.stats.tokensCacheWrite || 0;
    totals.errors += intel.toolErrors;
    totals.messages += session.stats.messages || 0;
    totals.edits += intel.editOperations;
    totals.additions += intel.additions;
    totals.deletions += intel.deletions;
    totals.changedLines += intel.changedLines;

    const startedDay = day(dayKey(session.startedAt));
    if (startedDay) {
      startedDay.sessions++;
      startedDay.errors += intel.toolErrors;
    }
    if (session.startedAt && session.endedAt) {
      const ms = Date.parse(session.endedAt) - Date.parse(session.startedAt);
      if (ms > 0 && ms < 86_400_000 && (!longest || ms > longest.ms)) longest = { ms, label: session.label, id: session.id };
    }

    for (const snapshot of session.limitSnapshots ?? []) {
      const normalized = normalizeLimitSnapshot(session, snapshot);
      if (!normalized) continue;
      limitHistory.push(normalized);
      const key = `${normalized.source}\u0000${normalized.provider}\u0000${normalized.limitId}`;
      const existing = latestLimits.get(key);
      const existingMs = existing?.ts ? Date.parse(existing.ts) : -Infinity;
      const candidateMs = normalized.ts ? Date.parse(normalized.ts) : -Infinity;
      if (!existing || candidateMs >= existingMs) latestLimits.set(key, normalized);
    }

    for (const edit of intel.edits) {
      const k = dayKey(edit.ts) ?? dayKey(session.startedAt);
      const d = day(k);
      if (d) { d.additions += edit.additions; d.deletions += edit.deletions; d.edits++; }
      const f = files.get(edit.path) ?? { path: edit.path, additions: 0, deletions: 0, edits: 0, sessionIds: new Set(), sources: new Set() };
      f.additions += edit.additions;
      f.deletions += edit.deletions;
      f.edits++;
      f.sessionIds.add(session.id);
      f.sources.add(session.source);
      files.set(edit.path, f);
    }
    if (intel.editOperations) totals.editCalls += session.events.filter((e) => extractEditOperations(e).length).length;

    sessionRows.push({
      id: session.id, source: session.source, label: session.label, model: session.model,
      apiCost: normalizedSessionCost.usd, rate: intel.cost.rate, edits: intel.editOperations,
      changedLines: intel.changedLines, reworkLoops: intel.reworkLoops, corrections: intel.corrections,
      abandoned: intel.abandoned, timeToFirstEditMs: intel.timeToFirstEditMs,
      costProvenance: normalizedSessionCost.provenance, costCoverage: normalizedSessionCost.coverage,
      pricedEvents: normalizedSessionCost.pricedEvents, unpricedEvents: normalizedSessionCost.unpricedEvents,
      longContextEvents: normalizedSessionCost.longContextEvents,
      contextUncertainEvents: normalizedSessionCost.contextUncertainEvents,
    });

    for (const ev of session.events) {
      if (!ev.ts) continue;
      const t = new Date(ev.ts);
      if (!Number.isNaN(t.getTime()) && (ev.kind === 'tool' || ev.kind === 'assistant')) punch[t.getDay()][t.getHours()]++;
      if (ev.kind !== 'tool') continue;
      totals.toolCalls++;
      const d = day(dayKey(ev.ts));
      if (d) d.toolCalls++;
      const rec = tools.get(ev.tool.name) || { name: ev.tool.name, count: 0, errors: 0 };
      rec.count++;
      if (ev.tool.isError) rec.errors++;
      tools.set(ev.tool.name, rec);
    }
  }

  totals.filesTouched = files.size;
  const fileRows = [...files.values()].map((f) => {
    const sessionsTouched = f.sessionIds.size;
    const churn = Math.max(0, sessionsTouched - 1) + Math.max(0, f.edits - sessionsTouched);
    const score = Math.round(Math.min(100,
      35 * Math.min(1, sessionsTouched / 4) + 25 * Math.min(1, f.edits / 8)
      + 25 * Math.min(1, churn / 6) + 15 * Math.min(1, (f.additions + f.deletions) / 500)));
    const directory = path.posix.dirname(f.path.replaceAll('\\', '/'));
    const dir = directories.get(directory) ?? { path: directory, edits: 0, additions: 0, deletions: 0, files: new Set(), sessions: new Set() };
    dir.edits += f.edits;
    dir.additions += f.additions;
    dir.deletions += f.deletions;
    dir.files.add(f.path);
    for (const id of f.sessionIds) dir.sessions.add(id);
    directories.set(directory, dir);
    return {
      path: f.path, directory, edits: f.edits, additions: f.additions, deletions: f.deletions,
      changedLines: f.additions + f.deletions, sessions: sessionsTouched, churn,
      sources: [...f.sources], riskScore: score, risk: riskLevel(score),
    };
  }).sort((a, b) => b.riskScore - a.riskScore || b.changedLines - a.changedLines);

  const directoryRows = [...directories.values()].map((d) => ({
    path: d.path, edits: d.edits, additions: d.additions, deletions: d.deletions,
    changedLines: d.additions + d.deletions, files: d.files.size, sessions: d.sessions.size,
  })).sort((a, b) => b.edits - a.edits || b.changedLines - a.changedLines);

  const keys = [...perDay.keys()].sort();
  const start = Number.isFinite(days)
    ? new Date(today.getTime() - (Math.max(1, days) - 1) * 86_400_000)
    : keys.length ? new Date(`${keys[0]}T00:00:00`) : today;
  const series = [];
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= today; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d);
    series.push(finalizedDay(day(k)));
  }

  const rolling = (minutes, rateKey, divisor) => {
    const fromMs = nowMs - minutes * 60_000;
    let tokens = 0;
    let eventCount = 0;
    for (const row of usageRows) {
      const ms = row.ts ? Date.parse(row.ts) : Number.NaN;
      if (!Number.isFinite(ms) || ms < fromMs || ms > nowMs) continue;
      tokens += row.tokens.total;
      eventCount++;
    }
    return {
      from: new Date(fromMs).toISOString(), to: asOf, minutes, tokens,
      [rateKey]: tokens / divisor, eventCount,
    };
  };

  const sevenStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  sevenStart.setDate(sevenStart.getDate() - 6);
  const sevenEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const sevenByDay = new Map();
  for (let d = new Date(sevenStart); d < sevenEnd; d.setDate(d.getDate() + 1)) {
    sevenByDay.set(dayKey(d), { date: dayKey(d), tokens: 0, cost: emptyCost() });
  }
  const sevenCost = emptyCost();
  let sevenTokens = 0;
  for (const row of usageRows) {
    const ms = row.ts ? Date.parse(row.ts) : Number.NaN;
    if (!Number.isFinite(ms) || ms < sevenStart.getTime() || ms >= sevenEnd.getTime()) continue;
    const bucket = sevenByDay.get(dayKey(row.ts));
    if (!bucket) continue;
    bucket.tokens += row.tokens.total;
    sevenTokens += row.tokens.total;
    addCost(bucket.cost, row.cost);
    addCost(sevenCost, row.cost);
  }
  const sevenCostSummary = finalizedCost(sevenCost);
  sevenCostSummary.averageUsdPerDay = sevenCostSummary.usd == null ? null : sevenCostSummary.usd / 7;
  const burnDays = [...sevenByDay.values()].map((row) => ({ date: row.date, tokens: row.tokens, cost: finalizedCost(row.cost) }));

  const modelRows = [...models.values()].map((row) => {
    const cost = finalizedCost(row.cost);
    return {
      source: row.source,
      provider: row.provider,
      model: row.model,
      name: row.name,
      sessions: row.sessionIds.size,
      eventCount: row.eventCount,
      tokens: row.tokens,
      cost,
      days: series.map(({ date }) => finalizedDay(row.days.get(date) ?? { date, ...emptyDailyUsage() })),
      apiCost: cost.usd ?? 0,
      pricedSessions: row.pricedSessionIds.size,
      rate: row.rate,
    };
  }).sort((a, b) => b.sessions - a.sessions || b.tokens.total - a.tokens.total);

  let peak = { weekday: 0, hour: 0, n: 0 };
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) if (punch[w][h] > peak.n) peak = { weekday: w, hour: h, n: punch[w][h] };
  const busiest = series.reduce((m, d) => (d.toolCalls > (m?.toolCalls || 0) ? d : m), null);
  const activeDays = series.filter((d) => d.toolCalls > 0 || d.sessions > 0).length;
  let streak = 0;
  for (let i = series.length - 1; i >= 0 && (series[i].toolCalls > 0 || series[i].sessions > 0); i--) streak++;

  const apiCost = sessionRows.reduce((n, s) => n + (s.apiCost || 0), 0);
  const pricedSessions = sessionRows.filter((s) => s.apiCost != null && s.unpricedEvents === 0).length;
  const pricedEdits = sessionRows.filter((s) => s.apiCost != null && s.unpricedEvents === 0).reduce((n, s) => n + s.edits, 0);
  const workflow = {
    reworkLoops: sessionRows.reduce((n, s) => n + s.reworkLoops, 0),
    sessionsWithRework: sessionRows.filter((s) => s.reworkLoops > 0).length,
    corrections: sessionRows.reduce((n, s) => n + s.corrections, 0),
    sessionsCorrected: sessionRows.filter((s) => s.corrections > 0).length,
    abandoned: sessionRows.filter((s) => s.abandoned).length,
    medianTimeToFirstEditMs: median(sessionRows.map((s) => s.timeToFirstEditMs)),
  };
  const usageCostSummary = finalizedCost(usageCost);
  const limitSort = (a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0);

  return {
    window: { from: series[0]?.date ?? dayKey(today), to: dayKey(today), days: Number.isFinite(days) ? days : null },
    pricing: {
      currency: pricing?.currency ?? 'USD',
      unit: pricing?.unit ?? 'per 1M tokens',
      tableUpdatedAt: pricing?.updatedAt ?? null,
      assumption: 'standard-api-token-rates',
      verifiedModels: (pricing?.models ?? []).filter((rate) => rate.verifiedAt && rate.sourceUrl).map((rate) => ({
        id: rate.id, verifiedAt: rate.verifiedAt, sourceUrl: rate.sourceUrl, serviceTier: rate.serviceTier ?? null,
      })),
    },
    totals,
    usage: {
      eventCount: usageRows.length,
      sessionCount: usageSessions.size,
      firstObservedAt: firstObservedMs == null ? null : new Date(firstObservedMs).toISOString(),
      lastObservedAt: lastObservedMs == null ? null : new Date(lastObservedMs).toISOString(),
      tokens: usageTotals,
      cost: usageCostSummary,
    },
    perDay: series,
    burn: {
      asOf,
      tenMinutes: rolling(10, 'tokensPerMinute', 10),
      oneHour: rolling(60, 'tokensPerHour', 1),
      sevenDays: {
        from: dayKey(sevenStart),
        to: dayKey(today),
        calendarDays: 7,
        tokens: sevenTokens,
        averageTokensPerDay: sevenTokens / 7,
        cost: sevenCostSummary,
        days: burnDays,
      },
    },
    limits: {
      latest: [...latestLimits.values()].sort(limitSort),
      history: limitHistory.sort(limitSort),
    },
    punch,
    tools: [...tools.values()].sort((a, b) => b.count - a.count),
    models: modelRows,
    impact: { files: fileRows, directories: directoryRows, churnFiles: fileRows.filter((f) => f.sessions > 1 || f.churn > 1) },
    scoreboard: [...sources.values()].map(finalizeSource).sort((a, b) => b.sessions - a.sessions),
    workflow,
    cost: {
      total: apiCost,
      pricedSessions,
      unpricedSessions: sessions.length - pricedSessions,
      coverage: sessions.length ? pricedSessions / sessions.length : 0,
      perSession: pricedSessions ? apiCost / pricedSessions : null,
      perEdit: pricedEdits ? apiCost / pricedEdits : null,
      reportedUsd: usageCostSummary.reportedUsd,
      estimatedUsd: usageCostSummary.estimatedUsd,
      pricedEvents: usageCostSummary.pricedEvents,
      unpricedEvents: usageCostSummary.unpricedEvents,
      longContextEvents: usageCostSummary.longContextEvents,
      contextUncertainEvents: usageCostSummary.contextUncertainEvents,
      eventCoverage: usageCostSummary.coverage,
      provenance: usageCostSummary.provenance,
      bySource: [...sources.values()].map(finalizeSource).map((s) => ({ source: s.source, total: s.apiCost, sessions: s.sessions, pricedSessions: s.pricedSessions, costPerEdit: s.costPerEdit, costPer100Lines: s.costPer100Lines })),
      sessions: sessionRows.sort((a, b) => (b.apiCost || 0) - (a.apiCost || 0)),
      pricingUpdatedAt: pricing?.updatedAt ?? null,
      currency: pricing?.currency ?? 'USD',
    },
    records: {
      longestSession: longest,
      busiestDay: busiest && busiest.toolCalls ? busiest : null,
      peakHour: peak.n ? peak : null,
      activeDays,
      streak,
    },
  };
}

export function sessionSummary(session, pricing, includeEvents = false) {
  const intel = sessionIntelligence(session, pricing);
  return {
    id: session.id,
    source: session.source,
    provider: session.provider ?? null,
    agent: session.agent,
    label: session.label,
    model: session.model,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    parent: session.parent,
    children: session.children,
    stats: session.stats,
    usageEventCount: session.usageEvents?.length ?? 0,
    limitSnapshotCount: session.limitSnapshots?.length ?? 0,
    eventCount: session.events.length,
    intelligence: {
      apiCost: intel.cost.total,
      rate: intel.cost.rate,
      rates: intel.cost.rates,
      costProvenance: intel.cost.provenance,
      costCoverage: intel.cost.coverage,
      unpricedEvents: intel.cost.unpricedEvents,
      longContextEvents: intel.cost.longContextEvents,
      contextUncertainEvents: intel.cost.contextUncertainEvents,
      edits: intel.editOperations,
      additions: intel.additions,
      deletions: intel.deletions,
      changedLines: intel.changedLines,
      files: intel.files,
      reworkLoops: intel.reworkLoops,
      corrections: intel.corrections,
      abandoned: intel.abandoned,
      timeToFirstEditMs: intel.timeToFirstEditMs,
      medianToolLatencyMs: intel.medianToolLatencyMs,
    },
    ...(includeEvents ? {
      events: session.events,
      usageEvents: session.usageEvents ?? [],
      limitSnapshots: session.limitSnapshots ?? [],
    } : {}),
  };
}
