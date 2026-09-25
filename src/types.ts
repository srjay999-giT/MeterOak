export type Page = 'overview' | 'models' | 'sessions' | 'budgets' | 'insights' | 'connections';
export type SourceChoice = 'all' | 'codex' | 'opencode';
export type Appearance = 'original' | 'portfolio';
export type UsageMetric = 'tokens' | 'cost';
export type NullableNumber = number | null;
export type Timestamp = string | number | null;
export interface Budget {
  amount: number;
  threshold: number;
}

export interface PricingTier {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface PricingRate extends PricingTier {
  id?: string;
  label?: string;
  serviceTier?: string | null;
  verifiedAt?: string | null;
  sourceUrl?: string | null;
  longContext?: (PricingTier & { thresholdInputTokens: number }) | null;
}
export interface PricingMetadata {
  assumption?: string;
  currency?: string;
  unit?: string;
  tableUpdatedAt?: string | null;
  verifiedModels?: Array<Pick<PricingRate, 'id' | 'verifiedAt' | 'sourceUrl' | 'serviceTier'>>;
}
export interface CostCoverage {
  cost?: NullableNumber;
  unpricedEvents?: NullableNumber;
  coverage?: NullableNumber;
}
export interface Totals {
  cost: NullableNumber;
  reportedCost: NullableNumber;
  estimatedCost: NullableNumber;
  costCoverage: NullableNumber;
  unpricedEvents: NullableNumber;
  longContextEvents: NullableNumber;
  contextUncertainEvents: NullableNumber;
  tokens: NullableNumber;
  input: NullableNumber;
  output: NullableNumber;
  reasoning: NullableNumber;
  cacheRead: NullableNumber;
  cacheWrite: NullableNumber;
  sessions: NullableNumber;
  usageSessions: NullableNumber;
  events: NullableNumber;
  toolCalls: NullableNumber;
  errors: NullableNumber;
}
export interface DayUsage {
  date: string | null;
  cost: NullableNumber;
  tokens: NullableNumber;
  sessions: NullableNumber;
  events: NullableNumber;
  unpricedEvents: NullableNumber;
  coverage: NullableNumber;
}
export interface ModelUsage extends Required<CostCoverage> {
  id: string;
  model: string | null;
  name: string;
  source: string | null;
  provider: string | null;
  tokens: NullableNumber;
  input: NullableNumber;
  output: NullableNumber;
  reasoning: NullableNumber;
  cacheRead: NullableNumber;
  cacheWrite: NullableNumber;
  sessions: NullableNumber;
  events: NullableNumber;
  provenance: string | null;
  rate: PricingRate | null;
  longContextEvents: NullableNumber;
  contextUncertainEvents: NullableNumber;
  days: DayUsage[];
}
export interface SessionUsage extends Required<CostCoverage> {
  id: string | null;
  source: string | null;
  model: string | null;
  label: string;
  startedAt: Timestamp;
  endedAt: Timestamp;
  pricedEvents: NullableNumber;
  provenance: string | null;
  tokens: NullableNumber;
  toolCalls: NullableNumber;
  errors: NullableNumber;
}
export interface SourceIssue {
  file: string | null;
  kind: string | null;
  message: string;
  count: NullableNumber;
}
export interface SourceStatus {
  id: string | null;
  available: boolean | null;
  files: NullableNumber;
  scannedFiles: NullableNumber;
  failedFiles: NullableNumber;
  staleFiles: NullableNumber;
  malformedLines: NullableNumber;
  oversizedLines: NullableNumber;
  pendingLines: NullableNumber;
  duplicateUsageEvents: NullableNumber;
  duplicateSessionFiles: NullableNumber;
  issues: SourceIssue[];
  sessions: NullableNumber;
  freshAt: Timestamp;
  warning: string | null;
}
export interface LimitSnapshot {
  source: string | null;
  provider: string | null;
  limitId: string | null;
  label: string;
  usedPercent: NullableNumber;
  remainingPercent: NullableNumber;
  windowMinutes: NullableNumber;
  resetsAt: Timestamp;
  planType: string | null;
  ts: Timestamp;
}
export interface Dashboard {
  generatedAt: Timestamp;
  pricing: PricingMetadata | null;
  totals: Totals;
  days: DayUsage[];
  models: ModelUsage[];
  sessions: SessionUsage[];
  sources: SourceStatus[];
  limits: LimitSnapshot[];
}

// Raw numbers remain unknown until normalization: a missing or malformed
// counter must never become a recorded zero.
export interface RawTokens {
  total?: unknown;
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}
export interface RawCost {
  usd?: unknown;
  reportedUsd?: unknown;
  estimatedUsd?: unknown;
  coverage?: unknown;
  unpricedEvents?: unknown;
  longContextEvents?: unknown;
  contextUncertainEvents?: unknown;
  provenance?: string | null;
}
export interface RawDayUsage {
  date?: string | null;
  tokens?: RawTokens | null;
  tokensIn?: unknown;
  tokensOut?: unknown;
  cost?: RawCost | null;
  apiCost?: unknown;
  usageSessionCount?: unknown;
  sessions?: unknown;
  eventCount?: unknown;
}
export interface RawModelUsage {
  source?: string | null;
  provider?: string | null;
  model?: string | null;
  name?: string | null;
  tokens?: RawTokens | null;
  cost?: RawCost | null;
  sessions?: unknown;
  eventCount?: unknown;
  rate?: PricingRate | null;
  days?: RawDayUsage[] | null;
}
export interface RawSessionCost {
  id?: string | null;
  apiCost?: unknown;
  costCoverage?: unknown;
  pricedEvents?: unknown;
  unpricedEvents?: unknown;
  costProvenance?: string | null;
}
export interface RawSessionUsage {
  id?: string | null;
  source?: string | null;
  model?: string | null;
  label?: string | null;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  stats?: {
    tokensIn?: unknown;
    tokensOut?: unknown;
    toolCounts?: Record<string, unknown> | null;
    errors?: unknown;
  } | null;
}
export interface RawSourceStatus {
  source?: string | null;
  available?: unknown;
  files?: unknown;
  scannedFiles?: unknown;
  failedFiles?: unknown;
  staleFiles?: unknown;
  malformedLines?: unknown;
  oversizedLines?: unknown;
  pendingLines?: unknown;
  duplicateUsageEvents?: unknown;
  duplicateSessionFiles?: unknown;
  issues?: Array<Partial<Omit<SourceIssue, 'count'>> & { count?: unknown }> | null;
  sessions?: unknown;
  freshAt?: Timestamp;
  warning?: string | null;
}
export interface RawStats {
  usage?: {
    cost?: RawCost | null;
    tokens?: RawTokens | null;
    sessionCount?: unknown;
    eventCount?: unknown;
  } | null;
  totals?: { sessions?: unknown; toolCalls?: unknown; errors?: unknown } | null;
  pricing?: PricingMetadata | null;
  perDay?: RawDayUsage[] | null;
  models?: RawModelUsage[] | null;
  cost?: { sessions?: RawSessionCost[] | null } | null;
  limits?: {
    latest?: Array<
      Partial<Omit<LimitSnapshot, 'usedPercent' | 'remainingPercent' | 'windowMinutes'>> & {
        usedPercent?: unknown;
        remainingPercent?: unknown;
        windowMinutes?: unknown;
      }
    > | null;
  } | null;
  window?: {
    from?: string | null;
    to?: string | null;
    days?: number | null;
  } | null;
}
export interface RawDashboardSnapshot {
  generatedAt?: Timestamp;
  windowMode?: string;
  windowDays?: number;
  stats?: RawStats | null;
  sourceStats?: Record<string, RawStats | undefined>;
  state?: { sessions?: RawSessionUsage[] | null } | null;
  sourceStatus?: RawSourceStatus[] | null;
}
