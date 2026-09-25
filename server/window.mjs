/** Strict calendar-window views for timestamped Codex/OpenCode records. */
export function calendarWindow(days, now = Date.now()) {
  const end = new Date(now);
  if (!Number.isInteger(days) || days < 1 || Number.isNaN(end.getTime())) {
    throw new Error('Strict usage windows require a positive integer --days and a valid date');
  }
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  return { from: start.getTime(), to: end.getTime() };
}

const count = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const timestamp = (value) => Date.parse(value ?? '');
const recordId = (event) => event.id ?? event.eventId ?? event.requestId ?? event.messageId ?? null;
const usageKey = (event) => JSON.stringify([
  recordId(event), event.ts, event.provider, event.model,
  event.tokensIn, event.tokensOut, event.tokensReasoning,
  event.tokensCacheRead, event.tokensCacheWrite, event.costUsd, event.costOrigin,
]);
const eventKey = (event) => event.kind === 'tool'
  ? JSON.stringify([recordId(event), event.kind, event.ts, event.tool?.id, event.tool?.name,
    event.tool?.id ? null : event.tool?.args])
  : JSON.stringify([recordId(event), event.kind, event.ts, event.text]);

const duplicateFields = {
  usageEvents: 'duplicateUsageEvents',
  events: 'duplicateActivityEvents',
  limitSnapshots: 'duplicateLimitSnapshots',
};
const diagnosticFields = ['duplicateSessionFiles', ...Object.values(duplicateFields)];

function diagnostic(diagnostics, source, field, amount = 1) {
  if (!diagnostics) return;
  diagnostics[field] += amount;
  diagnostics.bySource[source][field] += amount;
}

// Preserve repeated records within one stream. Across overlapping log files,
// keep the maximum observed multiplicity, so a copied prefix is counted once.
function mergeRecords(parts, field, keyOf, diagnostics) {
  const merged = new Map();
  for (const part of parts) {
    const occurrences = new Map();
    for (const record of part[field]) {
      const key = keyOf(record);
      const index = occurrences.get(key) ?? 0;
      occurrences.set(key, index + 1);
      const bucket = merged.get(key) ?? [];
      if (!bucket[index]) bucket[index] = record;
      else {
        diagnostic(diagnostics, part.source, duplicateFields[field]);
        if (field === 'events' && record.tool && (
          (!bucket[index].tool?.result && record.tool.result)
          || timestamp(record.tool.resultTs) > timestamp(bucket[index].tool?.resultTs)
        )) bucket[index] = record;
      }
      merged.set(key, bucket);
    }
  }
  return [...merged.values()].flat().sort((a, b) => timestamp(a.ts) - timestamp(b.ts));
}

/**
 * diagnostics accumulates confirmed removals within the requested window.
 * duplicateSessionFiles counts extra source/session file records consolidated,
 * including overlapping segments; it does not mean files were deleted on disk.
 * A parent/child link can mean an independent subagent, not copied fork history.
 * Without explicit original-record provenance, different session IDs stay apart.
 */
export function strictWindowSessions(sessions, { days = 30, now = Date.now(), diagnostics } = {}) {
  const window = calendarWindow(days, now);
  if (diagnostics) {
    for (const field of diagnosticFields) diagnostics[field] ??= 0;
    diagnostics.bySource ??= Object.create(null);
  }
  const inWindow = (event) => {
    const ms = timestamp(event.ts);
    return Number.isFinite(ms) && ms >= window.from && ms <= window.to;
  };
  const groups = new Map();
  for (const session of sessions) {
    const part = {
      ...session,
      usageEvents: (session.usageEvents ?? []).filter(inWindow),
      events: (session.events ?? []).filter(inWindow),
      limitSnapshots: (session.limitSnapshots ?? []).filter(inWindow),
    };
    if (!part.usageEvents.length && !part.events.length && !part.limitSnapshots.length) continue;
    const key = JSON.stringify([session.source, session.id]);
    const group = groups.get(key) ?? [];
    group.push(part);
    groups.set(key, group);
  }

  return [...groups.values()].map((parts) => {
    if (diagnostics) {
      const source = parts[0].source;
      if (!Object.hasOwn(diagnostics.bySource, source)) {
        Object.defineProperty(diagnostics.bySource, source, { value: {}, enumerable: true, configurable: true, writable: true });
      }
      for (const field of diagnosticFields) diagnostics.bySource[source][field] ??= 0;
      diagnostic(diagnostics, source, 'duplicateSessionFiles', parts.length - 1);
    }
    const latest = [...parts].sort((a, b) =>
      (timestamp(b.endedAt) || 0) - (timestamp(a.endedAt) || 0))[0];
    const usageEvents = mergeRecords(parts, 'usageEvents', usageKey, diagnostics);
    const events = mergeRecords(parts, 'events', eventKey, diagnostics);
    const limitSnapshots = mergeRecords(parts, 'limitSnapshots', (event) => JSON.stringify([
      event.ts, event.limitId, event.usedPercent, event.windowMinutes, event.resetsAt,
    ]), diagnostics);
    const stats = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, messages: 0, errors: 0, toolCounts: {} };
    for (const event of usageEvents) {
      stats.tokensIn += count(event.tokensIn) + count(event.tokensCacheRead) + count(event.tokensCacheWrite);
      stats.tokensOut += count(event.tokensOut) + count(event.tokensReasoning);
      stats.tokensCacheRead += count(event.tokensCacheRead);
      stats.tokensCacheWrite += count(event.tokensCacheWrite);
    }
    for (const event of events) {
      if (event.kind === 'user' || event.kind === 'assistant') stats.messages++;
      if (event.kind === 'tool') {
        const name = event.tool?.name ?? 'tool';
        stats.toolCounts[name] = (stats.toolCounts[name] ?? 0) + 1;
        if (event.tool?.isError) stats.errors++;
      }
    }
    const prefix = `${latest.source}:`;
    return {
      ...latest,
      id: prefix + latest.id,
      parent: latest.parent ? prefix + latest.parent : null,
      children: [...new Set(parts.flatMap((part) => part.children ?? []))].map((id) => prefix + id),
      // Cross-file linking must not mutate cached event objects in this view.
      spawnCandidates: [],
      startedAt: parts.map((part) => part.startedAt).filter(Boolean).sort()[0] ?? null,
      endedAt: parts.map((part) => part.endedAt).filter(Boolean).sort().at(-1) ?? null,
      stats, usageEvents, events, limitSnapshots,
      usageWindowApplied: true,
    };
  });
}
