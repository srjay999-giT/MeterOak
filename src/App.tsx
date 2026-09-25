import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeDashboard,
  money,
  compact,
  number,
  shortDate,
  cacheReuse,
  dashboardCSV,
  sourceHasIssues,
  sourceLabel,
} from './data';
import type { Appearance, Budget, Dashboard, Page, RawDashboardSnapshot, Timestamp } from './types';
import { BudgetPanel, ConnectionsPanel, InsightsPanel, SourceQualityBanner } from './panels';
import { UsageChart } from './UsageChart';
import { PricingDetails } from './PricingDetails';
import { ModelBars, Models } from './models';
import { Icon } from './components/Icon';
import { Sessions } from './components/Sessions';
import { TokenBreakdown } from './components/TokenBreakdown';
import { sourceName } from './sourceName';
import { settingKeys } from './settings';
import { isDemo, loadDemoDashboard } from './demo';

const nav: Array<[Page, string, string]> = [
  ['overview', 'Overview', 'grid'],
  ['models', 'Models', 'layers'],
  ['sessions', 'Session history', 'list'],
  ['budgets', 'Budgets', 'wallet'],
  ['insights', 'Insights', 'spark'],
  ['connections', 'Connections', 'plug'],
];
const formatTime = (date: Timestamp) =>
  date
    ? new Date(date).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

function exportCSV(data: Dashboard, source: string, page: Page) {
  const modelMode = page === 'models';
  const text = dashboardCSV(data, modelMode);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `meteroak-${isDemo ? 'demo-' : ''}${source}-${modelMode ? 'models' : 'sessions'}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function App() {
  const [design, setDesign] = useState<Appearance>(() => {
    try {
      return localStorage.getItem(settingKeys.appearance) === 'original' ? 'original' : 'portfolio';
    } catch {
      return 'portfolio';
    }
  });
  const [page, setPage] = useState<Page>('overview');
  const [source, setSource] = useState<string>('all');
  const [raw, setRaw] = useState<RawDashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const pending = useRef(false);
  const [budgets, setBudgets] = useState<Record<string, Budget | null>>(() => {
    try {
      const b: unknown = JSON.parse(localStorage.getItem(settingKeys.budgets) ?? 'null');
      return b && typeof b === 'object'
        ? (b as Record<string, Budget | null>)
        : isDemo
          ? { all: { amount: 2000, threshold: 80 } }
          : {};
    } catch {
      return {};
    }
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.design = design;
  }, [design]);
  const changeDesign = (next: Appearance) => {
    setDesign(next);
    try {
      localStorage.setItem(settingKeys.appearance, next);
    } catch {
      setToast('Design changed for this visit. Browser storage is unavailable.');
    }
  };
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      let next: RawDashboardSnapshot;
      if (isDemo) {
        next = await loadDemoDashboard();
      } else {
        const response = await fetch('/api/dashboard?source=all', {
          signal: AbortSignal.timeout(90000),
        });
        if (!response.ok) throw new Error(`Reader returned ${response.status}`);
        next = await response.json();
      }
      if (!next.stats?.usage) throw new Error('The usage reader returned an incomplete snapshot.');
      setRaw(next);
      setError(null);
    } catch (e) {
      setError(
        isDemo
          ? 'Could not load the demo snapshot. Refresh this page to try again.'
          : e instanceof Error && e.name === 'TimeoutError'
            ? 'The local reader is taking longer than expected. Try refreshing.'
            : 'Cannot reach the local usage reader. Start it and refresh this page.',
      );
    } finally {
      setBusy(false);
      pending.current = false;
    }
  }, []);
  useEffect(() => {
    refresh();
    if (isDemo) return;
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if ((raw || error) && document.documentElement.dataset.meteroakReady !== 'true') {
      document.documentElement.dataset.meteroakReady = 'true';
      window.dispatchEvent(new Event('meteroak:ready'));
    }
  }, [raw, error]);
  useEffect(() => {
    if (!menuOpen) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [menuOpen]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  const data = useMemo(
    () =>
      normalizeDashboard(
        source === 'all'
          ? raw
          : {
              ...raw,
              stats: raw?.sourceStats?.[source],
              state: { sessions: raw?.state?.sessions?.filter((s) => s.source === source) },
            },
      ),
    [raw, source],
  );
  const budget = budgets[source] ?? null;
  const navigate = (next: Page) => {
    setPage(next);
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const saveBudget = (next: Budget | null) => {
    const updated = { ...budgets, [source]: next };
    try {
      localStorage.setItem(settingKeys.budgets, JSON.stringify(updated));
      setBudgets(updated);
      setToast(next ? 'Cost target saved on this browser' : 'Cost target removed');
    } catch {
      setToast('Could not save. Browser storage is unavailable.');
    }
  };
  const title = nav.find((n) => n[0] === page)?.[1];
  const cost = data.totals.cost;
  const cacheRate = cacheReuse(data.totals);
  const visibleSources =
    source === 'all' ? data.sources : data.sources.filter((s) => s.id === source);
  const sourceIssues = visibleSources.some(sourceHasIssues);
  const noSources = visibleSources.length > 0 && visibleSources.every((s) => s.available === false);
  const activeSources = data.sources.filter((s) => s.available && (s.sessions ?? 0) > 0).length;
  const notice = budget && cost != null && (cost / budget.amount) * 100 >= budget.threshold;
  return (
    <div className={`app-shell ${design} page-${page}`}>
      {menuOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside id="sidebar-navigation" className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <a
          className="brand"
          href="#overview"
          aria-label="MeterOak overview"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-wordmark">
            MeterOak<small>{isDemo ? 'DEMO WORKSPACE' : 'LOCAL WORKSPACE'}</small>
          </span>
        </a>
        <div className="workspace-pill">
          <span className="workspace-symbol">{isDemo ? 'D' : 'K'}</span>
          <div>
            <strong>{isDemo ? 'Demo workspace' : 'My workspace'}</strong>
            <span>{isDemo ? 'Sample analytics' : 'Personal analytics'}</span>
          </div>
          <Icon name="chevron" size={15} />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {nav.slice(0, 5).map(([key, label, icon]) => (
            <button
              key={key}
              className={page === key ? 'nav-item active' : 'nav-item'}
              aria-current={page === key ? 'page' : undefined}
              onClick={() => navigate(key)}
            >
              <Icon name={icon} />
              {label}
              {key === 'insights' && (data.totals.unpricedEvents ?? 0) > 0 && (
                <span className="nav-dot" />
              )}
            </button>
          ))}
        </nav>
        <span className="nav-label manage-label">MANAGE</span>
        <button
          className={`nav-item ${page === 'connections' ? 'active' : ''}`}
          onClick={() => navigate('connections')}
        >
          <Icon name="plug" />
          Connections<span className="nav-count">{activeSources}</span>
        </button>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <Icon name="shield" />
            <strong>{isDemo ? 'Sample data only.' : 'Your data stays here.'}</strong>
            <p>
              {isDemo
                ? 'This demo never reads your local history or AI accounts.'
                : 'Read from your local usage history. Nothing sent to the cloud.'}
            </p>
          </div>
          <div className="profile">
            <span className="avatar">{isDemo ? 'D' : 'K'}</span>
            <div>
              <strong>{isDemo ? 'Demo workspace' : 'Personal workspace'}</strong>
              <span>{isDemo ? 'Historical sample' : 'On this computer'}</span>
            </div>
            <span className="status-dot" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-controls="sidebar-navigation"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span>{isDemo ? 'Demo' : 'Workspace'}</span>
            <b>/</b>
            <strong>{title}</strong>
          </div>
          <div className="topbar-right">
            <label className="appearance-control">
              <span>Appearance</span>
              <select
                aria-label="Appearance"
                value={design}
                onChange={(e) => changeDesign(e.target.value as Appearance)}
              >
                <option value="portfolio">Portfolio</option>
                <option value="original">Original</option>
              </select>
            </label>
            <span
              className={`connection-status ${error ? 'offline' : sourceIssues ? 'partial' : ''}`}
            >
              <i className="status-dot" />
              {isDemo
                ? error
                  ? 'Demo unavailable'
                  : 'Sample data'
                : error
                  ? 'Reader offline'
                  : raw
                    ? sourceIssues
                      ? 'Partial local data'
                      : noSources
                        ? 'No local source found'
                        : 'Local data connected'
                    : 'Reading local usage…'}
            </span>
            <span className="topbar-divider" />
            <span className="avatar small-avatar">{isDemo ? 'D' : 'K'}</span>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR AI, IN PERSPECTIVE</div>
              <h1>{page === 'overview' ? 'Usage overview' : title}</h1>
              <p>
                {
                  {
                    overview: 'Understand your AI usage. Make every token count.',
                    models: 'See which models do the work, and what that work costs.',
                    sessions: 'Explore the usage behind your conversations and coding sessions.',
                    budgets: 'Keep your estimated usage cost within a target you choose.',
                    insights: 'Useful signals from the usage you have already recorded.',
                    connections: isDemo
                      ? 'Explore the usage sources in this sample snapshot.'
                      : 'One view of the AI tools on this computer.',
                  }[page]
                }
              </p>
            </div>
            <div className="heading-actions">
              <button
                className={`button refresh-button ${busy ? 'is-refreshing' : ''}`}
                disabled={busy}
                onClick={refresh}
                aria-label={isDemo ? 'Reload sample data' : 'Refresh usage'}
              >
                <Icon name="refresh" />
              </button>
              <button
                className="button"
                disabled={!raw}
                onClick={() => {
                  exportCSV(data, source, page);
                  setToast('CSV download requested');
                }}
              >
                <Icon name="download" size={16} />
                Export CSV
              </button>
            </div>
          </div>
          {isDemo && (
            <p className="notice" role="note" aria-label="Demo data notice">
              <strong>Demo · sample data.</strong> A sanitized historical snapshot from September
              25, 2026. No local history or AI accounts are accessed. Saved targets apply only to
              this demo.
            </p>
          )}
          <div className="filter-bar">
            <label>
              <span className="sr-only">Usage source</span>
              <Icon name="layers" size={16} />
              <select
                aria-label="Usage source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="all">All sources</option>
                <option value="codex">Codex</option>
                <option value="opencode">OpenCode</option>
              </select>
            </label>
            <span className="filter-divider" />
            <div className="date-label">
              <Icon name="clock" size={15} />
              <strong>{isDemo ? 'Sample 30 days' : 'Last 30 days'}</strong>
              <span>
                {raw?.stats?.window?.from
                  ? `${shortDate(raw.stats.window.from)} – ${shortDate(raw.stats.window.to)}`
                  : ''}
              </span>
            </div>
            <span className="filter-spacer" />
            <span className="muted refresh-label">
              {isDemo
                ? 'Historical snapshot'
                : raw
                  ? `Updated ${formatTime(data.generatedAt)}`
                  : 'Scanning your history…'}
            </span>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <Icon name="info" />
              <span>
                {error}
                {raw ? ' Showing the last successful snapshot.' : ''}
              </span>
              <button className="text-button" onClick={refresh}>
                Retry
              </button>
            </div>
          )}
          {raw && (
            <SourceQualityBanner
              sources={visibleSources}
              onReview={() => navigate('connections')}
            />
          )}
          {!raw ? (
            <section className="panel loading-panel">
              <div className={error ? '' : 'loader'} />
              <h2>
                {isDemo
                  ? error
                    ? 'Demo data is unavailable'
                    : 'Loading the sample snapshot'
                  : error
                    ? 'Your reader needs attention'
                    : 'Bringing your usage into focus'}
              </h2>
              <p className="muted">
                {isDemo
                  ? 'This demo uses a bundled sample. Refresh the page to load it again.'
                  : error
                    ? 'Run npm start in the MeterOak folder to start both services.'
                    : 'Reading local Codex and OpenCode history. The first scan can take a moment.'}
              </p>
            </section>
          ) : (
            <>
              {notice && budget && cost !== null && page === 'overview' && (
                <div className="budget-alert">
                  <Icon name="wallet" />
                  <span>
                    <strong>
                      {cost >= budget.amount
                        ? 'Cost target reached'
                        : 'Approaching your cost target'}
                    </strong>{' '}
                    · {money(cost)} of {money(budget.amount)} in estimated usage
                  </span>
                  <button className="text-button" onClick={() => navigate('budgets')}>
                    Manage target <Icon name="arrow" size={14} />
                  </button>
                </div>
              )}
              {page === 'overview' && (
                <>
                  <div className="overview-layout">
                    <div className="stats-grid">
                      {[
                        [
                          'Standard API estimate',
                          money(cost) +
                            (cost != null && (data.totals.unpricedEvents ?? 0) > 0 ? '+' : ''),
                          'wallet',
                          data.totals.unpricedEvents
                            ? `${number(data.totals.unpricedEvents)} events not priced`
                            : 'From your recorded token usage',
                          'violet',
                        ],
                        [
                          'Total tokens',
                          compact(data.totals.tokens),
                          'chip',
                          `${compact(data.totals.output)} output · ${compact(data.totals.reasoning)} reasoning`,
                          'blue',
                        ],
                        [
                          'Usage events',
                          number(data.totals.events),
                          'layers',
                          `Across ${number(data.totals.usageSessions)} sessions`,
                          'teal',
                        ],
                        [
                          'Input cache reuse',
                          cacheRate === null ? '—' : `${cacheRate.toFixed(1)}%`,
                          'refresh',
                          cacheRate === null
                            ? 'No recorded input denominator'
                            : `${compact(data.totals.cacheRead)} cached input tokens`,
                          'orange',
                        ],
                      ].map(([label, value, icon, sub, color]) => (
                        <section className={`stat-card ${color}`} key={label}>
                          <div>
                            <span>{label}</span>
                            <span className="stat-icon">
                              <Icon name={icon} size={17} />
                            </span>
                          </div>
                          <strong>{value}</strong>
                          <p>{sub}</p>
                        </section>
                      ))}
                    </div>
                    <div className="overview-grid">
                      <UsageChart key={source} data={data} />
                      <ModelBars data={data} onNavigate={navigate} />
                    </div>
                    <div className="lower-grid">
                      <TokenBreakdown data={data} />
                      <section className="panel source-overview">
                        <div className="panel-head">
                          <div>
                            <h2 className="panel-title">
                              {isDemo ? 'Sample usage sources' : 'Your connected tools'}
                            </h2>
                            <p className="muted">
                              {isDemo
                                ? 'Tools represented in this snapshot'
                                : 'A direct line to your local history'}
                            </p>
                          </div>
                          <Icon name="plug" />
                        </div>
                        {data.sources.map((s) => (
                          <button
                            className="source-row"
                            key={s.id}
                            onClick={() => {
                              if (s.id !== null) setSource(s.id);
                              navigate('connections');
                            }}
                          >
                            <span className={`source-symbol ${s.id}`}>
                              {s.id === 'codex' ? <Icon name="spark" size={22} /> : 'O'}
                            </span>
                            <div>
                              <strong>{sourceName(s.id)}</strong>
                              <span>
                                {(s.sessions ?? 0) > 0
                                  ? `${number(s.sessions)} sessions found`
                                  : sourceHasIssues(s)
                                    ? 'Scan needs attention'
                                    : s.available === false
                                      ? 'No local source found'
                                      : s.available
                                        ? 'No sessions recorded'
                                        : 'Scan status unavailable'}
                              </span>
                            </div>
                            <span
                              className={`badge ${sourceHasIssues(s) ? 'warning' : s.available ? 'success' : ''}`}
                            >
                              {isDemo ? 'Sample' : sourceLabel(s)}
                            </span>
                            <Icon name="arrow" size={15} />
                          </button>
                        ))}
                        <p className="source-footnote">
                          <Icon name="shield" size={13} />{' '}
                          {isDemo
                            ? 'Historical sample · no device access'
                            : 'Read-only access to usage records'}
                        </p>
                      </section>
                    </div>
                  </div>
                  <Sessions data={data} compactView onNavigate={navigate} />
                </>
              )}
              {page === 'models' && <Models data={data} />}
              {page === 'sessions' && <Sessions data={data} />}
              {page === 'budgets' && (
                <BudgetPanel data={data} source={source} budget={budget} onSave={saveBudget} />
              )}
              {page === 'insights' && <InsightsPanel data={data} onNavigate={navigate} />}
              {page === 'connections' && <ConnectionsPanel data={data} onRefresh={refresh} />}
              <PricingDetails data={data} />
              <footer className="page-footer">
                <span>
                  <Icon name="info" size={14} /> Estimates use saved standard API rates. This
                  dashboard does not read your billing account.
                </span>
                <span>
                  {isDemo ? 'Sample data' : 'Local only'} <i className="status-dot" />
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Icon name="shield" size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
