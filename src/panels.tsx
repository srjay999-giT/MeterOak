import type { FormEvent } from 'react';
import type {
  Budget,
  Dashboard,
  DayUsage,
  ModelUsage,
  Page,
  SourceStatus,
  Timestamp,
} from './types';
import { useEffect, useState } from 'react';
import { money, compact, number, sourceHasIssues, sourceLabel } from './data';

const sourceNames: Record<string, string> = {
  all: 'All sources',
  codex: 'Codex',
  opencode: 'OpenCode',
};
const sourceName = (source: string | null | undefined) =>
  sourceNames[source ?? ''] || source || 'Unknown source';
const validNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const percent = (value: number) => `${Math.round(value * 100)}%`;
const recordedAt = (value: Timestamp | undefined) => {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
};

function Progress({ value, label }: { value: number | null; label: string }) {
  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={validNumber(value) ? Math.min(100, Math.max(0, value)) : undefined}
    >
      <i
        style={{
          width: `${validNumber(value) ? Math.min(100, Math.max(0, value)) : 0}%`,
        }}
      />
    </div>
  );
}

export function BudgetPanel({
  data,
  source,
  budget,
  onSave,
}: {
  data: Dashboard;
  source: string;
  budget: Budget | null;
  onSave: (budget: Budget | null) => void;
}) {
  const [amount, setAmount] = useState<number | string>(budget?.amount ?? '');
  const [threshold, setThreshold] = useState<number | string>(budget?.threshold ?? 80);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setAmount(budget?.amount ?? '');
    setThreshold(budget?.threshold ?? 80);
    setError('');
  }, [budget?.amount, budget?.threshold, source]);
  useEffect(() => {
    setMessage('');
  }, [source]);

  const cost = validNumber(data?.totals?.cost) ? data.totals.cost : null;
  const incomplete = (data?.totals?.unpricedEvents || 0) > 0;
  const used = budget && cost !== null ? (cost / budget.amount) * 100 : null;
  const reached = used !== null && budget !== null && used >= budget.threshold;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextAmount = Number(amount);
    const nextThreshold = Number(threshold);
    if (
      !Number.isFinite(nextAmount) ||
      nextAmount <= 0 ||
      !Number.isFinite(nextThreshold) ||
      nextThreshold < 1 ||
      nextThreshold > 100
    ) {
      setError('Enter a cost target above $0 and a warning threshold from 1 to 100%.');
      setMessage('');
      return;
    }
    onSave({ amount: nextAmount, threshold: nextThreshold });
    setError('');
    setMessage('Cost target saved for this source.');
  }

  return (
    <div className="card-grid">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">{sourceName(source)}</p>
            <h2 className="panel-title">Rolling 30-day cost target</h2>
          </div>
          <span className={`badge ${budget ? (reached ? 'warning' : 'success') : ''}`}>
            {budget ? (reached ? 'Threshold reached' : 'Target active') : 'No target'}
          </span>
        </div>
        <p className="muted">
          Keep a personal target for the API-equivalent cost of your recorded usage.
        </p>
        <div className="metric-value">
          {money(cost)}
          {incomplete && cost !== null ? '+' : ''}
        </div>
        <p className="muted">Known cost · Last 30 days</p>
        {budget ? (
          <>
            <Progress value={used} label="Recorded cost as a percentage of your target" />
            <div className="stat-row">
              <span>
                {used === null
                  ? 'Cost unavailable'
                  : `${Math.round(used)}% of target${incomplete ? ' or more' : ''}`}
              </span>
              <strong>{money(budget.amount)}</strong>
            </div>
            <div className="stat-row">
              <span>Warning threshold</span>
              <strong>
                {budget.threshold}% · {money((budget.amount * budget.threshold) / 100)}
              </strong>
            </div>
            {reached && (
              <p className="notice" role="status">
                Recorded cost has reached your warning threshold. Review your model usage to see
                what contributed.
              </p>
            )}
          </>
        ) : (
          <p className="empty-state">Set a target to see your usage against it here.</p>
        )}
        {incomplete && (
          <p className="notice">
            Some usage has no matching price. This is a lower bound; the full API-equivalent cost
            may be higher.
          </p>
        )}
        <p className="muted">
          This target is informational. API-equivalent cost is not your invoice, and a target does
          not stop usage or billing.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Your preference</p>
            <h2 className="panel-title">Set your cost target</h2>
          </div>
        </div>
        <p className="muted">
          Saved in this browser for {sourceName(source).toLowerCase()}. The rolling window updates
          each day.
        </p>
        <form onSubmit={save}>
          <div className="form-grid">
            <label className="field">
              30-day target (USD)
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                required
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setMessage('');
                }}
                placeholder="e.g. 100.00"
              />
            </label>
            <label className="field">
              Warning threshold (%)
              <input
                type="number"
                min="1"
                max="100"
                step="any"
                inputMode="decimal"
                required
                value={threshold}
                onChange={(event) => {
                  setThreshold(event.target.value);
                  setMessage('');
                }}
              />
            </label>
          </div>
          <p className="muted">
            The warning appears in this dashboard when known cost reaches your threshold.
          </p>
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <div className="panel-head">
            <button className="button primary" type="submit">
              Save target
            </button>
            {budget && (
              <button
                className="button"
                type="button"
                onClick={() => {
                  onSave(null);
                  setError('');
                  setMessage('Cost target removed.');
                }}
              >
                Remove target
              </button>
            )}
          </div>
          <p className="muted" role="status" aria-live="polite">
            {message}
          </p>
        </form>
      </section>
    </div>
  );
}

export function SourceQualityBanner({
  sources,
  onReview,
}: {
  sources: SourceStatus[];
  onReview: () => void;
}) {
  const troubled = sources.filter(sourceHasIssues);
  const missing = sources.length > 0 && sources.every((source) => source.available === false);
  if (!troubled.length && !missing) return null;
  return (
    <div className="data-quality-banner" role="status">
      <div>
        <strong>{troubled.length ? 'Local data needs attention' : 'No local sources found'}</strong>
        <p>
          {troubled.length
            ? `${troubled.map((source) => sourceName(source.id)).join(', ')}: some records could not be included or refreshed. Totals may be incomplete, and saved records may be out of date.`
            : 'No saved usage source was found for this selection. These totals do not confirm that no usage occurred.'}
        </p>
      </div>
      <button className="button small" onClick={onReview}>
        Review sources
      </button>
    </div>
  );
}

export function ConnectionsPanel({ data, onRefresh }: { data: Dashboard; onRefresh: () => void }) {
  const sources: Partial<SourceStatus>[] = data?.sources?.length
    ? data.sources
    : [
        { id: 'codex', available: null },
        { id: 'opencode', available: null },
      ];
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">On this computer</p>
            <h2 className="panel-title">Your usage sources</h2>
          </div>
          <button className="button" onClick={onRefresh}>
            Scan again
          </button>
        </div>
        <p className="muted">
          MeterOak reads local usage records from your coding tools. You do not need to enter an API
          key.
        </p>
      </section>
      <div className="card-grid">
        {sources.map((source) => (
          <section className="panel" key={source.id}>
            <div className="panel-head">
              <div className="insight-row">
                <span className="source-symbol" aria-hidden="true">
                  {source.id === 'codex'
                    ? 'Cx'
                    : source.id === 'opencode'
                      ? 'Oc'
                      : sourceName(source.id).slice(0, 2)}
                </span>
                <h2 className="panel-title">{sourceName(source.id)}</h2>
              </div>
              <span
                className={`badge ${sourceHasIssues(source) ? 'warning' : source.available ? 'success' : ''}`}
              >
                {sourceLabel(source)}
              </span>
            </div>
            <p className="muted">
              {source.id === 'codex'
                ? 'Usage recorded by Codex on this computer.'
                : source.id === 'opencode'
                  ? 'Usage recorded by OpenCode on this computer.'
                  : 'Usage available in local records.'}
            </p>
            <div className="stat-row">
              <span>Sessions found</span>
              <strong>{number(source.sessions)}</strong>
            </div>
            <div className="stat-row">
              <span>Files found / scanned</span>
              <strong>
                {number(source.files)} / {number(source.scannedFiles)}
              </strong>
            </div>
            <div className="stat-row">
              <span>Duplicate usage records removed</span>
              <strong>{number(source.duplicateUsageEvents)}</strong>
            </div>
            <div className="stat-row">
              <span>Extra session files merged</span>
              <strong>{number(source.duplicateSessionFiles)}</strong>
            </div>
            <div className="stat-row">
              <span>Latest recorded activity</span>
              <strong>
                {source.freshAt
                  ? recordedAt(source.freshAt)
                  : sourceHasIssues(source)
                    ? 'Activity unavailable'
                    : 'No activity found'}
              </strong>
            </div>
            {sourceHasIssues(source) && (
              <div className="source-scan-summary" aria-label="Scan problems">
                {(
                  [
                    ['Failed files', source.failedFiles],
                    ['Stale files', source.staleFiles],
                    ['Malformed lines skipped', source.malformedLines],
                    ['Oversized lines skipped', source.oversizedLines],
                  ] as Array<[string, number | null | undefined]>
                )
                  .filter(([, count]) => (count ?? 0) > 0)
                  .map(([label, count]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <strong>{number(count)}</strong>
                    </div>
                  ))}
              </div>
            )}
            {source.warning && <p className="notice">{source.warning}</p>}
            {(source.issues?.length ?? 0) > 0 && (
              <details className="source-issues">
                <summary>
                  Review {number(source.issues?.length)} scan{' '}
                  {source.issues?.length === 1 ? 'issue' : 'issues'}
                </summary>
                <ul>
                  {source.issues?.map((issue, index) => (
                    <li key={index}>
                      <strong title={issue.file || undefined}>
                        {issue.file?.split(/[\\/]/).pop() || 'Source scan'}
                        {(issue.count ?? 0) > 1 ? ` · ${number(issue.count)} occurrences` : ''}
                      </strong>
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {(source.pendingLines ?? 0) > 0 && (
              <p className="muted">
                {number(source.pendingLines)} incomplete{' '}
                {source.pendingLines === 1 ? 'line is' : 'lines are'} waiting for the tool to finish
                writing. A later scan can include them.
              </p>
            )}
            {sourceHasIssues(source) && (
              <p className="muted">
                Usage totals may be incomplete. Resolve the scan issues and scan again; stale files
                may still contribute previously saved records.
              </p>
            )}
            {source.available === false && !sourceHasIssues(source) && (
              <p className="muted">
                Run {sourceName(source.id)} on this computer, then scan again. Only activity saved
                locally can appear here.
              </p>
            )}
          </section>
        ))}
      </div>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">From local records</p>
            <h2 className="panel-title">Recorded usage limits</h2>
          </div>
          <span className="badge">Snapshots</span>
        </div>
        <p className="muted">
          These percentages were captured during past activity. They are not a live account quota
          check.
        </p>
        {data?.limits?.length ? (
          data.limits.map((limit, index) => (
            <div className="insight-row" key={limit.limitId || index}>
              <div className="wide">
                <div className="stat-row">
                  <strong>{limit.label}</strong>
                  <span>
                    {validNumber(limit.usedPercent)
                      ? `${Math.round(limit.usedPercent)}% used`
                      : 'Usage unavailable'}
                  </span>
                </div>
                <Progress value={limit.usedPercent} label={`${limit.label}, recorded usage`} />
                <p className="muted">
                  Recorded {recordedAt(limit.ts)}
                  {limit.resetsAt ? ` · Recorded reset ${recordedAt(limit.resetsAt)}` : ''}
                </p>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-state">
            <p>No usage-limit snapshots found.</p>
            <p className="muted">
              Limits appear when a supported tool saves them in its local activity records.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

export function InsightsPanel({
  data,
  onNavigate,
}: {
  data: Dashboard;
  onNavigate: (page: Page) => void;
}) {
  const totals = data.totals;
  const inputValues = [totals.input, totals.cacheRead, totals.cacheWrite];
  const allInput = inputValues.every(validNumber)
    ? inputValues.reduce((sum, value) => sum + value, 0)
    : null;
  const cacheShare =
    allInput !== null && allInput > 0 && totals.cacheRead !== null
      ? totals.cacheRead / allInput
      : null;
  const pricedModels = (data?.models || [])
    .filter(
      (model): model is ModelUsage & { cost: number } => validNumber(model.cost) && model.cost > 0,
    )
    .sort((a, b) => b.cost - a.cost);
  const modelTotal = pricedModels.reduce((sum, model) => sum + model.cost, 0);
  const topModel = pricedModels[0];
  const coverage = validNumber(totals.costCoverage)
    ? Math.min(1, Math.max(0, totals.costCoverage))
    : null;
  const recentDays = (data?.days || [])
    .filter(
      (day): day is DayUsage & { date: string } =>
        Boolean(day.date) && Number.isFinite(Date.parse(day.date ?? '')),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-7);
  const hasWeek =
    recentDays.length === 7 &&
    recentDays.every(
      (day, index) =>
        index === 0 || Date.parse(day.date) - Date.parse(recentDays[index - 1].date) === 86_400_000,
    );
  const costDays = recentDays.filter((day): day is DayUsage & { date: string; cost: number } =>
    validNumber(day.cost),
  );
  const tokenDays = recentDays.filter((day): day is DayUsage & { date: string; tokens: number } =>
    validNumber(day.tokens),
  );
  const dailyCost =
    hasWeek && costDays.length ? costDays.reduce((sum, day) => sum + day.cost, 0) / 7 : null;
  const dailyTokens =
    hasWeek && tokenDays.length ? tokenDays.reduce((sum, day) => sum + day.tokens, 0) / 7 : null;
  const costLowerBound =
    costDays.length < 7 || (totals.unpricedEvents || 0) > 0 || coverage === null;
  const tokenLowerBound = tokenDays.length < 7;

  return (
    <div className="card-grid">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Reuse</p>
            <h2 className="panel-title">Cached input</h2>
          </div>
          <span className="icon-box" aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
            >
              <path d="M3 4v6h6M3.4 9a9 9 0 1 1 .8 8" />
            </svg>
          </span>
        </div>
        <div className="metric-value">{cacheShare === null ? '—' : percent(cacheShare)}</div>
        <p className="muted">Share of input tokens read from cache</p>
        <Progress
          value={cacheShare === null ? null : cacheShare * 100}
          label="Cached share of input tokens"
        />
        <div className="stat-row">
          <span>Cache read</span>
          <strong>{compact(totals.cacheRead)} tokens</strong>
        </div>
        <div className="stat-row">
          <span>All input, including cache</span>
          <strong>{compact(allInput)} tokens</strong>
        </div>
        <p className="muted">
          {cacheShare === null
            ? 'Cache share will appear when input token records are available.'
            : 'Cache reuse depends on your tool and provider. This measures recorded reuse; it does not estimate potential savings.'}
        </p>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Cost concentration</p>
            <h2 className="panel-title">Largest priced model</h2>
          </div>
        </div>
        {topModel ? (
          <>
            <div className="metric-value">{percent(topModel.cost / modelTotal)}</div>
            <p>
              <strong>{topModel.name}</strong>
            </p>
            <p className="muted">{money(topModel.cost)} · share of known model cost in this view</p>
            <Progress
              value={(topModel.cost / modelTotal) * 100}
              label={`${topModel.name} share of known model cost`}
            />
            <p className="muted">
              Start here when reviewing what contributes to your usage cost. Models without prices
              are excluded from this share.
            </p>
            <button className="button" onClick={() => onNavigate('models')}>
              Review models
            </button>
          </>
        ) : (
          <div className="empty-state">
            <p>No priced model usage yet.</p>
            <p className="muted">
              Model shares need usage with a matching price or a reported cost.
            </p>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Data quality</p>
            <h2 className="panel-title">Pricing coverage</h2>
          </div>
          <span
            className={`badge ${coverage === 1 ? 'success' : coverage !== null ? 'warning' : ''}`}
          >
            {coverage === 1 ? 'Complete' : coverage !== null ? 'Partial' : 'Unavailable'}
          </span>
        </div>
        <div className="metric-value">{coverage === null ? '—' : percent(coverage)}</div>
        <p className="muted">Recorded usage events with a known cost</p>
        <Progress
          value={coverage === null ? null : coverage * 100}
          label="Pricing coverage of recorded usage events"
        />
        <div className="stat-row">
          <span>Events without a price</span>
          <strong>{number(totals.unpricedEvents)}</strong>
        </div>
        <p className="muted">
          {coverage === 1
            ? 'Every recorded usage event in this view has a reported cost or a matching model price.'
            : 'Unknown pricing is left unpriced. Known cost may understate the full API-equivalent cost of your usage.'}
        </p>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Reading your numbers</p>
            <h2 className="panel-title">What cost includes</h2>
          </div>
        </div>
        <div className="stat-row">
          <span>Cost reported by tools</span>
          <strong>{money(totals.reportedCost)}</strong>
        </div>
        <div className="stat-row">
          <span>Estimated from model prices</span>
          <strong>{money(totals.estimatedCost)}</strong>
        </div>
        <div className="stat-row">
          <span>Known cost</span>
          <strong>{money(totals.cost)}</strong>
        </div>
        <p className="muted">
          Estimates apply available model prices to recorded tokens. Your subscription, credits, and
          provider invoice may use different billing rules.
        </p>
        <p className="notice">
          Use this view to understand local usage. Check your provider for the amount actually
          billed.
        </p>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Recent pace</p>
            <h2 className="panel-title">30-day cost run rate</h2>
          </div>
          <span className="badge">Projection</span>
        </div>
        <div className="metric-value">
          {money(dailyCost === null ? null : dailyCost * 30)}
          {dailyCost !== null && costLowerBound ? '+' : ''}
        </div>
        <p className="muted">Priced usage projected at the same recent pace</p>
        <div className="stat-row">
          <span>Known daily average · Recent 7 days</span>
          <strong>
            {money(dailyCost)}
            {dailyCost !== null && costLowerBound ? '+' : ''}
          </strong>
        </div>
        {dailyCost === null ? (
          <p className="muted">
            A run rate needs seven consecutive daily records and at least one known cost. Missing
            observations are not treated as free usage.
          </p>
        ) : (
          <>
            <p className="muted">
              Recent seven-day known cost ÷ 7 × 30. This is a pace-based projection of
              API-equivalent usage, not a provider invoice or a prediction of future activity.
            </p>
            {costLowerBound && (
              <p className="notice">
                Lower bound: some usage is unpriced or pricing coverage is unavailable. The full run
                rate may be higher.
              </p>
            )}
          </>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Activity</p>
            <h2 className="panel-title">Daily token pace</h2>
          </div>
        </div>
        <div className="metric-value">
          {compact(dailyTokens)}
          {dailyTokens !== null && tokenLowerBound ? '+' : ''}
        </div>
        <p className="muted">Known tokens per day · Recent 7 days</p>
        <div className="stat-row">
          <span>Usage events · Last 30 days</span>
          <strong>{number(totals.events)}</strong>
        </div>
        <div className="stat-row">
          <span>Sessions · Last 30 days</span>
          <strong>{number(totals.sessions)}</strong>
        </div>
        <p className="muted">
          {dailyTokens === null
            ? 'A daily pace needs seven consecutive daily records and at least one known token total.'
            : tokenLowerBound
              ? 'Lower bound: some days have no token total. This is known seven-day usage divided by seven; missing observations are not counted as recorded zeroes.'
              : 'Recorded tokens over the most recent seven calendar days, divided by seven. Days with recorded zero usage are included.'}
        </p>
      </section>
    </div>
  );
}
