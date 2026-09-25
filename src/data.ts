import type {
  CostCoverage,
  Dashboard,
  DayUsage,
  ModelUsage,
  RawCost,
  RawDashboardSnapshot,
  RawDayUsage,
  SessionUsage,
  SourceStatus,
  Totals,
} from './types';

const numeric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const rows = <T>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);
const sum = (values: unknown[]): number | null => {
  if (!values.every((value): value is number => numeric(value) !== null)) return null;
  return values.reduce((total, value) => total + value, 0);
};

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const integers = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const abbreviated = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const dates = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const localDates = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

export const money = (value: unknown): string => {
  const amount = numeric(value);
  return amount === null ? '—' : dollars.format(amount);
};
export const number = (value: unknown): string => {
  const amount = numeric(value);
  return amount === null ? '—' : integers.format(amount);
};
export const compact = (value: unknown): string => {
  const amount = numeric(value);
  return amount === null ? '—' : abbreviated.format(amount);
};
export function shortDate(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dates.format(date);
}

// Calendar buckets are UTC dates; session timestamps are instants in the viewer's timezone.
export function localDate(value: string | number | null | undefined, timeZone?: string) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  const formatter = timeZone
    ? new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone,
      })
    : localDates;
  return Number.isNaN(date.getTime()) ? '—' : formatter.format(date);
}

export function cacheReuse(
  totals: Partial<Pick<Totals, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>>,
) {
  const input = sum([totals.input, totals.cacheRead, totals.cacheWrite]);
  return input !== null && input > 0 && totals.cacheRead !== null && totals.cacheRead !== undefined
    ? (totals.cacheRead / input) * 100
    : null;
}

export const costStatus = (row: CostCoverage) =>
  numeric(row.cost) === null
    ? (row.unpricedEvents ?? 0) > 0
      ? 'Unpriced'
      : 'Unknown'
    : (row.unpricedEvents ?? 0) > 0 ||
        (typeof row.coverage === 'number' && Number.isFinite(row.coverage) && row.coverage < 1)
      ? 'Partial'
      : row.unpricedEvents === 0 || row.coverage === 1
        ? 'Priced'
        : 'Coverage unknown';
export const costText = (row: CostCoverage) =>
  costStatus(row) === 'Unpriced'
    ? 'Unpriced'
    : money(row.cost) + (costStatus(row) === 'Partial' ? '+' : '');

export const sourceHasIssues = (source: Partial<SourceStatus>) =>
  (['failedFiles', 'staleFiles', 'malformedLines', 'oversizedLines'] as const).some(
    (key) => (source[key] ?? 0) > 0,
  ) ||
  rows(source.issues).some(
    (issue) => !['pending', 'pendingLines', 'pending-write'].includes(issue.kind ?? ''),
  ) ||
  Boolean(source.available && source.warning);
export const sourceLabel = (source: Partial<SourceStatus>) =>
  sourceHasIssues(source)
    ? (source.sessions ?? 0) > 0 || (source.scannedFiles ?? 0) > 0
      ? 'Partial data'
      : 'Scan failed'
    : source.available
      ? (source.sessions ?? 0) > 0
        ? 'Detected'
        : 'No usage'
      : source.available === false
        ? 'Not found'
        : 'Not scanned';

export function dashboardCSV(
  data: { models?: Partial<ModelUsage>[]; sessions?: Partial<SessionUsage>[] },
  modelMode: boolean,
) {
  const records = (modelMode ? data.models : data.sessions) ?? [];
  const fields = modelMode
    ? [
        'name',
        'source',
        'cost',
        'costStatus',
        'coverage',
        'unpricedEvents',
        'provenance',
        'tokens',
        'sessions',
        'events',
      ]
    : [
        'id',
        'source',
        'model',
        'startedAt',
        'cost',
        'costStatus',
        'coverage',
        'unpricedEvents',
        'provenance',
        'tokens',
        'toolCalls',
        'errors',
      ];
  const escape = (value: unknown) =>
    '"' +
    String(value ?? '')
      .replace(/^[=+@\t\r-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  return [
    fields,
    ...records.map((row) => {
      const values: Record<string, unknown> = { ...row };
      return fields.map((field) => (field === 'costStatus' ? costStatus(row) : values[field]));
    }),
  ]
    .map((row) => row.map(escape).join(','))
    .join('\r\n');
}

function normalizeDay(day: RawDayUsage, fallbackCost: RawCost = {}): DayUsage {
  const dailyTokens = numeric(day.tokens?.total) ?? sum([day.tokensIn, day.tokensOut]);
  const hasDailyCost = day.cost && typeof day.cost === 'object';
  const dailyCost = hasDailyCost ? numeric(day.cost?.usd) : numeric(day.apiCost);
  // Compatibility with a reader started before daily coverage was added. Such
  // rows cannot distinguish a free event from an unpriced one.
  const unknownLegacyZero =
    !hasDailyCost &&
    dailyCost === 0 &&
    (dailyTokens ?? 0) > 0 &&
    ((numeric(fallbackCost.unpricedEvents) ?? 0) > 0 || fallbackCost.provenance === 'unpriced');
  return {
    date: day.date ?? null,
    cost: unknownLegacyZero ? null : dailyCost,
    tokens: dailyTokens,
    sessions: numeric(day.usageSessionCount) ?? numeric(day.sessions),
    events: numeric(day.eventCount),
    unpricedEvents: numeric(day.cost?.unpricedEvents),
    coverage: numeric(day.cost?.coverage),
  };
}

/** Normalize the local Usage Hub snapshot without filling missing usage or cost. */
export function normalizeDashboard(value: unknown): Dashboard {
  // The reader contract describes shape; numeric fields are validated individually below.
  const raw = value as RawDashboardSnapshot | null | undefined;
  const stats = raw?.stats ?? {};
  const usage = stats.usage ?? {};
  const cost = usage.cost ?? {};
  const tokens = usage.tokens ?? {};
  const totals = stats.totals ?? {};
  const sessionCosts = new Map(rows(stats.cost?.sessions).map((row) => [row.id, row]));

  return {
    generatedAt: raw?.generatedAt ?? null,
    pricing: stats.pricing ?? null,
    totals: {
      cost: numeric(cost.usd),
      reportedCost: numeric(cost.reportedUsd),
      estimatedCost: numeric(cost.estimatedUsd),
      costCoverage: numeric(cost.coverage),
      unpricedEvents: numeric(cost.unpricedEvents),
      longContextEvents: numeric(cost.longContextEvents),
      contextUncertainEvents: numeric(cost.contextUncertainEvents),
      tokens: numeric(tokens.total),
      input: numeric(tokens.input),
      output: numeric(tokens.output),
      reasoning: numeric(tokens.reasoning),
      cacheRead: numeric(tokens.cacheRead),
      cacheWrite: numeric(tokens.cacheWrite),
      sessions: numeric(totals.sessions),
      usageSessions: numeric(usage.sessionCount),
      events: numeric(usage.eventCount),
      toolCalls: numeric(totals.toolCalls),
      errors: numeric(totals.errors),
    },
    days: rows(stats.perDay).map((day) => normalizeDay(day, cost)),
    models: rows(stats.models).map((model) => ({
      id: [model.source, model.provider, model.model].map((value) => value ?? '').join('::'),
      model: model.model ?? null,
      name: model.name ?? model.model ?? 'Unknown model',
      source: model.source ?? null,
      provider: model.provider ?? null,
      cost: numeric(model.cost?.usd),
      tokens: numeric(model.tokens?.total),
      input: numeric(model.tokens?.input),
      output: numeric(model.tokens?.output),
      reasoning: numeric(model.tokens?.reasoning),
      cacheRead: numeric(model.tokens?.cacheRead),
      cacheWrite: numeric(model.tokens?.cacheWrite),
      sessions: numeric(model.sessions),
      events: numeric(model.eventCount),
      coverage: numeric(model.cost?.coverage),
      provenance: model.cost?.provenance ?? null,
      rate: model.rate ?? null,
      longContextEvents: numeric(model.cost?.longContextEvents),
      contextUncertainEvents: numeric(model.cost?.contextUncertainEvents),
      unpricedEvents: numeric(model.cost?.unpricedEvents),
      days: rows(model.days).map((day) => normalizeDay(day, model.cost ?? undefined)),
    })),
    sessions: rows(raw?.state?.sessions).map((session) => ({
      id: session.id ?? null,
      source: session.source ?? null,
      model: session.model ?? null,
      label: session.label ?? 'Untitled session',
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      // Per-event costs preserve different models and pricing coverage in one session.
      cost: numeric(sessionCosts.get(session.id)?.apiCost),
      coverage: numeric(sessionCosts.get(session.id)?.costCoverage),
      pricedEvents: numeric(sessionCosts.get(session.id)?.pricedEvents),
      unpricedEvents: numeric(sessionCosts.get(session.id)?.unpricedEvents),
      provenance: sessionCosts.get(session.id)?.costProvenance ?? null,
      tokens: sum([session.stats?.tokensIn, session.stats?.tokensOut]),
      toolCalls:
        session.stats?.toolCounts && typeof session.stats.toolCounts === 'object'
          ? sum(Object.values(session.stats.toolCounts))
          : null,
      errors: numeric(session.stats?.errors),
    })),
    sources: rows(raw?.sourceStatus).map((source) => ({
      id: source.source ?? null,
      available: typeof source.available === 'boolean' ? source.available : null,
      files: numeric(source.files),
      scannedFiles: numeric(source.scannedFiles),
      failedFiles: numeric(source.failedFiles),
      staleFiles: numeric(source.staleFiles),
      malformedLines: numeric(source.malformedLines),
      oversizedLines: numeric(source.oversizedLines),
      pendingLines: numeric(source.pendingLines),
      duplicateUsageEvents: numeric(source.duplicateUsageEvents),
      duplicateSessionFiles: numeric(source.duplicateSessionFiles),
      issues: rows(source.issues).map((issue) => ({
        file: issue.file ?? null,
        kind: issue.kind ?? null,
        message: issue.message ?? 'Scan issue',
        count: numeric(issue.count),
      })),
      sessions: numeric(source.sessions),
      freshAt: source.freshAt ?? null,
      warning: source.warning ?? null,
    })),
    limits: rows(stats.limits?.latest).map((limit) => ({
      source: limit.source ?? null,
      provider: limit.provider ?? null,
      limitId: limit.limitId ?? null,
      label: limit.label ?? 'Usage limit',
      usedPercent: numeric(limit.usedPercent),
      remainingPercent: numeric(limit.remainingPercent),
      windowMinutes: numeric(limit.windowMinutes),
      resetsAt: limit.resetsAt ?? null,
      planType: limit.planType ?? null,
      ts: limit.ts ?? null,
    })),
  };
}
