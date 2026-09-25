import { useEffect, useState } from 'react';
import { compact, costText, localDate, number } from '../data';
import type { Dashboard, Page } from '../types';
import { sourceName } from '../sourceName';
import { Icon } from './Icon';
import { isDemo } from '../demo';

const costBasis: Record<string, string> = {
  reported: 'Reported by source',
  estimated: 'Estimated from tokens',
  mixed: 'Reported + estimated',
  unpriced: 'No matching price',
};

export function Sessions({
  data,
  compactView = false,
  onNavigate,
}: {
  data: Dashboard;
  compactView?: boolean;
  onNavigate?: (page: Page) => void;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = data.sessions.find((s) => `${s.source}:${s.id}` === activeId) || null;
  useEffect(() => {
    setPage(1);
  }, [search, data.totals.sessions]);
  useEffect(() => {
    if (!active) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveId(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [active]);
  const filtered = [...data.sessions]
    .filter((s) =>
      `${s.model} ${s.source} ${s.label} ${s.id}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime());
  const size = compactView ? 5 : 12;
  const visible = filtered.slice((page - 1) * size, page * size);
  return (
    <section className="panel sessions-panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">{compactView ? 'Recent sessions' : 'Session history'}</h2>
          <p className="muted">
            {compactView
              ? isDemo
                ? 'A closer look at the sample activity'
                : 'A closer look at your latest activity'
              : `${number(filtered.length)} sessions in ${isDemo ? 'the sample snapshot' : 'the last 30 days'}`}
          </p>
        </div>
        {compactView ? (
          <button className="text-button" onClick={() => onNavigate?.('sessions')}>
            View all <Icon name="arrow" size={15} />
          </button>
        ) : (
          <label className="search-field">
            <Icon name="search" />
            <input
              aria-label="Search sessions"
              placeholder="Search model or session…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        )}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Source</th>
              <th>Tokens</th>
              <th>API cost</th>
              <th>Started (local)</th>
              <th>
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={`${s.source}:${s.id}`}>
                <td>
                  <div className="table-model">
                    <span className="model-symbol">{s.source === 'codex' ? 'C' : 'O'}</span>
                    <div>
                      <strong>{s.model || 'Unknown model'}</strong>
                      <small>{String(s.id).slice(0, 15)}…</small>
                    </div>
                  </div>
                </td>
                <td>
                  <span className="source-chip">{sourceName(s.source)}</span>
                </td>
                <td>{compact(s.tokens)}</td>
                <td className="strong">
                  {costText(s)}
                  {(s.unpricedEvents ?? 0) > 0 && (
                    <small className="session-cost-note">
                      {number(s.unpricedEvents)} unpriced{' '}
                      {s.unpricedEvents === 1 ? 'event' : 'events'}
                    </small>
                  )}
                </td>
                <td className="muted">{localDate(s.startedAt)}</td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={`View session ${s.id}`}
                    onClick={() => setActiveId(`${s.source}:${s.id}`)}
                  >
                    <Icon name="arrow" size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!visible.length && (
        <div className="empty-state">
          {search ? 'No sessions match your search.' : 'No sessions recorded for this source yet.'}
        </div>
      )}
      {!compactView && (
        <div className="table-footer">
          <span>
            {filtered.length
              ? `${(page - 1) * size + 1}–${Math.min(page * size, filtered.length)}`
              : '0'}{' '}
            of {number(filtered.length)} sessions
          </span>
          <div>
            <button
              className="button small"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <button
              className="button small"
              disabled={page * size >= filtered.length}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
      {active && (
        <div className="modal-backdrop" onClick={() => setActiveId(null)}>
          <section
            className="modal panel"
            role="dialog"
            aria-modal="true"
            aria-label="Session details"
            onKeyDown={(e) => {
              if (e.key === 'Tab') e.preventDefault();
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-head">
              <div>
                <span className="eyebrow">SESSION DETAIL</span>
                <h2>{active.model || 'Unknown model'}</h2>
              </div>
              <button
                autoFocus
                className="icon-button"
                aria-label="Close session details"
                onClick={() => setActiveId(null)}
              >
                <Icon name="close" />
              </button>
            </div>
            <p className="session-id">{active.id}</p>
            {[
              ['Source', sourceName(active.source)],
              [
                'Started',
                active.startedAt && !Number.isNaN(new Date(active.startedAt).getTime())
                  ? new Date(active.startedAt).toLocaleString()
                  : 'Not recorded',
              ],
              ['Tokens', number(active.tokens)],
              ['API cost', costText(active)],
              ['Cost basis', costBasis[active.provenance ?? ''] || 'Not recorded'],
              ['Priced events', number(active.pricedEvents)],
              ['Unpriced events', number(active.unpricedEvents)],
              ['Tool calls', number(active.toolCalls)],
              ['Recorded errors', number(active.errors)],
            ].map(([label, value]) => (
              <div className="stat-row" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
            <p className="notice">
              {(active.unpricedEvents ?? 0) > 0
                ? 'Unpriced events are included in token totals. Their unknown cost is excluded from this subtotal. '
                : ''}
              Usage metadata only. Prompt and response contents are not shown.
            </p>
          </section>
        </div>
      )}
    </section>
  );
}
