import type { Dashboard, ModelUsage, Page, UsageMetric } from './types';
import { useState } from 'react';
import { compact, money, number } from './data';
import { isDemo } from './demo';
import './models.css';

const valid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const sourceNames: Record<string, string> = {
  codex: 'Codex',
  opencode: 'OpenCode',
};
const sourceName = (source: string | null) =>
  sourceNames[source ?? ''] || source || 'Unknown source';
const exactModel = (model: ModelUsage) => model.model || model.name || 'Unknown model';
const share = (value: unknown, total: number | null) =>
  valid(value) && total !== null && total > 0 ? (value / total) * 100 : null;
const showShare = (value: number | null) =>
  value === null ? 'Share unavailable' : `${value > 0 && value < 0.1 ? '<0.1' : value.toFixed(1)}%`;
const costText = (cost: unknown) => (valid(cost) ? money(cost) : 'Unpriced');

export function modelLabel(name: string | null | undefined) {
  if (!name) return 'Unknown model';
  const labels: Array<[string, string]> = [
    ['gpt-6-astra', 'GPT-6 Astra'],
    ['gpt-6-sol', 'GPT-6 Sol'],
    ['gpt-6-luna', 'GPT-6 Luna'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['gpt-5.6-terra', 'GPT-5.6 Terra'],
    ['gpt-5.6-luna', 'GPT-5.6 Luna'],
    ['gpt-5.5', 'GPT-5.5'],
    ['codex-auto-review', 'Codex auto-review'],
  ];
  const label = labels.find(([id]) => name === id || name.startsWith(`${id}-`));
  return label ? label[1] + name.slice(label[0].length) : name;
}

export function modelColor(name = '') {
  const known: Record<string, string> = {
    'gpt-6-astra': 'var(--model-astra, #6556db)',
    'gpt-5.6-sol': 'var(--model-sol, #399c91)',
    'codex-auto-review': 'var(--model-review, #93a1b8)',
  };
  if (known[name]) return known[name];
  const palette = ['#648dd2', '#bd85ba', '#c59064', '#8a80b8', '#6798a5', '#c57f8f'];
  let hash = 0;
  for (const letter of String(name)) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  const index = hash % palette.length;
  return `var(--model-${name === '(unknown model)' ? 'unknown' : `palette-${index}`}, ${palette[index]})`;
}

function ModelIcon({ color }: { color: string }) {
  return (
    <span className="model-symbol" style={{ color }} aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" />
      </svg>
    </span>
  );
}

export function ModelBars({
  data,
  onNavigate,
}: {
  data: Dashboard;
  onNavigate: (page: Page) => void;
}) {
  const [metric, setMetric] = useState<UsageMetric>('tokens');
  const models = data?.models || [];
  const ordered = [...models].sort(
    (a, b) =>
      (valid(b[metric]) ? b[metric] : -1) - (valid(a[metric]) ? a[metric] : -1) ||
      exactModel(a).localeCompare(exactModel(b)),
  );
  const total = models.reduce((sum, model) => sum + (valid(model[metric]) ? model[metric] : 0), 0);
  const visible = ordered.slice(0, 6);
  const missing = models.filter((model) => !valid(model[metric])).length;

  return (
    <section className="panel model-panel cp-models-overview">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Usage by model</h2>
          <p className="muted">Your recorded models, individually</p>
        </div>
        <button
          className="icon-button"
          aria-label="View all models"
          onClick={() => onNavigate('models')}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path d="M5 12h14m-5-5 5 5-5 5" />
          </svg>
        </button>
      </div>
      <div className="cp-model-controls">
        <div className="segmented" aria-label="Model comparison metric">
          <button
            className={metric === 'tokens' ? 'active' : ''}
            aria-pressed={metric === 'tokens'}
            onClick={() => setMetric('tokens')}
          >
            Tokens
          </button>
          <button
            className={metric === 'cost' ? 'active' : ''}
            aria-pressed={metric === 'cost'}
            onClick={() => setMetric('cost')}
          >
            Cost
          </button>
        </div>
        <span>{metric === 'tokens' ? 'Share of recorded tokens' : 'Share of priced cost'}</span>
      </div>
      {visible.length ? (
        <div className="cp-model-bars">
          {visible.map((model) => {
            const id = exactModel(model);
            const value = model[metric];
            const ratio = share(value, total);
            const color = modelColor(id);
            return (
              <div className="cp-model-bar" key={model.id}>
                <div className="cp-model-bar-heading">
                  <span className="cp-model-display">
                    <i style={{ background: color }} aria-hidden="true" />
                    <strong>{modelLabel(id)}</strong>
                  </span>
                  <strong
                    className="cp-model-value"
                    title={
                      metric === 'tokens' && valid(value) ? `${number(value)} tokens` : undefined
                    }
                  >
                    {metric === 'tokens'
                      ? valid(value)
                        ? compact(value)
                        : 'Not recorded'
                      : costText(value)}
                  </strong>
                </div>
                <div className="cp-model-id" title={id}>
                  {id}
                </div>
                <div
                  className={`cp-model-meter${valid(value) ? '' : ' is-unavailable'}`}
                  role="img"
                  aria-label={`${modelLabel(id)}: ${valid(value) ? (metric === 'tokens' ? `${number(value)} tokens` : money(value)) : metric === 'cost' ? 'Unpriced' : 'Tokens not recorded'}${ratio === null ? '' : `, ${showShare(ratio)} of ${metric === 'tokens' ? 'recorded tokens' : 'priced cost'}`}`}
                >
                  <i
                    style={{
                      width: `${ratio === null ? 0 : Math.min(100, Math.max(0, ratio))}%`,
                      background: color,
                    }}
                  />
                </div>
                <div className="cp-model-bar-detail">
                  <span>
                    {sourceName(model.source)} · {number(model.events)} events
                  </span>
                  <span>
                    {valid(value)
                      ? total > 0
                        ? showShare(ratio)
                        : metric === 'tokens'
                          ? '0 recorded tokens'
                          : 'No priced cost'
                      : metric === 'tokens'
                        ? 'No token record'
                        : 'No matching price'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">Models appear when your local tools record usage.</div>
      )}
      {missing > 0 && (
        <p className="cp-model-footnote">
          {metric === 'cost'
            ? `${number(missing)} model${missing === 1 ? ' is' : 's are'} unpriced. Token usage is still available.`
            : `${number(missing)} model${missing === 1 ? ' has' : 's have'} no recorded token total.`}
        </p>
      )}
      {models.length > 0 && (
        <button className="text-button cp-model-view-all" onClick={() => onNavigate('models')}>
          View all {number(models.length)} model records <span aria-hidden="true">→</span>
        </button>
      )}
    </section>
  );
}

export function Models({ data }: { data: Dashboard }) {
  type ModelSort = UsageMetric | 'events' | 'sessions';
  const [sort, setSort] = useState<ModelSort>('tokens');
  const [search, setSearch] = useState('');
  const all = data?.models || [];
  const query = search.trim().toLowerCase();
  const models = all
    .filter((model) =>
      [exactModel(model), modelLabel(exactModel(model)), model.name, model.source, model.provider]
        .join(' ')
        .toLowerCase()
        .includes(query),
    )
    .sort(
      (a, b) =>
        (valid(b[sort]) ? b[sort] : -1) - (valid(a[sort]) ? a[sort] : -1) ||
        exactModel(a).localeCompare(exactModel(b)),
    );
  const knownTokens = all.filter((model): model is ModelUsage & { tokens: number } =>
    valid(model.tokens),
  );
  const totalTokens = knownTokens.length
    ? knownTokens.reduce((sum, model) => sum + model.tokens, 0)
    : null;
  const unpriced = all.filter((model) => !valid(model.cost)).length;

  return (
    <div className="cp-models-page">
      <div className="model-summary cp-model-summary">
        <div>
          <strong>{number(all.length)}</strong>
          <span>Model records</span>
        </div>
        <div>
          <strong>{compact(totalTokens)}</strong>
          <span>Recorded model tokens</span>
        </div>
        <div>
          <strong>
            {costText(data?.totals?.cost)}
            {valid(data?.totals?.cost) && (data?.totals?.unpricedEvents ?? 0) > 0 ? '+' : ''}
          </strong>
          <span>
            {unpriced ? `${number(unpriced)} models without pricing` : 'Known API-equivalent cost'}
          </span>
        </div>
      </div>
      <section className="panel cp-model-table-panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Model breakdown</h2>
            <p className="muted">
              {isDemo
                ? 'Exact models from the sample snapshot · Sample 30 days'
                : 'Exact models from your local records · Last 30 days'}
            </p>
          </div>
          <div className="chart-actions cp-model-table-actions">
            <label className="search-field">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <circle cx="10" cy="10" r="6" />
                <path d="m15 15 5 5" />
              </svg>
              <input
                type="search"
                aria-label="Search models by name or exact ID"
                placeholder="Search name or model ID…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <select
              aria-label="Sort models"
              value={sort}
              onChange={(event) => setSort(event.target.value as ModelSort)}
            >
              <option value="tokens">Most tokens</option>
              <option value="events">Most events</option>
              <option value="sessions">Most sessions</option>
              <option value="cost">Highest known cost</option>
            </select>
          </div>
        </div>
        <div className="table-scroll">
          <table className="cp-model-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Source</th>
                <th scope="col">Tokens</th>
                <th scope="col">Events</th>
                <th scope="col">Sessions</th>
                <th scope="col">Est. API cost</th>
                <th scope="col">Pricing coverage</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const id = exactModel(model);
                const ratio = share(model.tokens, totalTokens);
                const coverage = valid(model.coverage)
                  ? Math.min(1, Math.max(0, model.coverage))
                  : null;
                return (
                  <tr key={model.id}>
                    <th scope="row">
                      <div className="table-model">
                        <ModelIcon color={modelColor(id)} />
                        <div>
                          <strong>{modelLabel(id)}</strong>
                          <code>{id}</code>
                        </div>
                      </div>
                    </th>
                    <td>
                      <span className="source-chip">{sourceName(model.source)}</span>
                      {model.provider && (
                        <small className="cp-table-subline">{model.provider}</small>
                      )}
                    </td>
                    <td>
                      <strong
                        className="cp-table-tokens"
                        title={valid(model.tokens) ? `${number(model.tokens)} tokens` : undefined}
                      >
                        {valid(model.tokens) ? compact(model.tokens) : 'Not recorded'}
                      </strong>
                      <small className="cp-table-subline">
                        {ratio === null
                          ? valid(model.tokens)
                            ? '0 recorded tokens'
                            : 'Share unavailable'
                          : `${showShare(ratio)} of tokens`}
                      </small>
                    </td>
                    <td>{number(model.events)}</td>
                    <td>{number(model.sessions)}</td>
                    <td className={valid(model.cost) ? 'strong' : 'cp-unpriced'}>
                      {costText(model.cost)}
                      {valid(model.cost) && coverage !== null && coverage < 1 && (
                        <small className="cp-table-subline">Partial cost</small>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${coverage === 1 ? 'success' : coverage !== null ? 'warning' : ''}`}
                      >
                        {coverage === null
                          ? 'Not available'
                          : coverage === 0
                            ? 'Unpriced'
                            : `${Math.round(coverage * 100)}% priced`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!models.length && (
          <div className="empty-state">
            <p>
              {query
                ? `No recorded models match “${search.trim()}”.`
                : 'No model usage recorded for this source yet.'}
            </p>
            {query ? (
              <button className="text-button" onClick={() => setSearch('')}>
                Clear search
              </button>
            ) : (
              <p className="muted">Run a supported coding tool, then refresh your local usage.</p>
            )}
          </div>
        )}
        <div className="cp-model-table-footer">
          <span>
            {number(models.length)} of {number(all.length)} model records
          </span>
          <span>Sessions can use more than one model.</span>
        </div>
      </section>
      <p className="cp-model-footnote">
        Model IDs are preserved exactly; sources are listed separately. Unpriced usage still counts
        toward tokens, events, and sessions.
      </p>
    </div>
  );
}
