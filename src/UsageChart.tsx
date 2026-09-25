import React, { useEffect, useRef, useState } from 'react';
import type { Dashboard, DayUsage, ModelUsage, UsageMetric } from './types';
import { compact, money, number, shortDate } from './data';
import { modelLabel, modelColor } from './models';
import './chart.css';

const costText = (day: DayUsage) =>
  day.cost == null ? 'Unpriced' : `${money(day.cost)}${(day.unpricedEvents ?? 0) > 0 ? '+' : ''}`;
const dayText = (day: DayUsage, mode: UsageMetric) =>
  mode === 'cost' ? costText(day) : `${number(day.tokens)} tokens`;

export function UsageChart({ data }: { data: Dashboard }) {
  const [period, setPeriod] = useState(30);
  const [mode, setMode] = useState<UsageMetric>('tokens');
  const [modelId, setModelId] = useState('all');
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(620);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wrap.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, entry.contentRect.width)),
    );
    observer.observe(wrap.current);
    return () => observer.disconnect();
  }, []);
  const selectedModel = data.models.find((m) => m.id === modelId);
  const activeId = selectedModel?.id ?? 'all';
  const models = selectedModel
    ? [selectedModel]
    : [...data.models].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
  const days = [...(selectedModel?.days ?? data.days)]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-period);
  const series = models.map((m) => ({
    ...m,
    byDay: new Map((m.days ?? []).map((d) => [d.date, d])),
  }));
  const total = days.reduce((sum, d) => sum + (d[mode] ?? 0), 0);
  const unpricedDays = days.filter((d) => (d.unpricedEvents ?? 0) > 0).length;
  const known = days.some(
    (d) =>
      d[mode] != null &&
      (mode === 'tokens' ||
        (d.cost ?? 0) > 0 ||
        !unpricedDays ||
        (d.events ?? 0) > (d.unpricedEvents ?? 0)),
  );
  const max = Math.max(1, ...days.map((d) => d[mode] ?? 0)) * 1.15;
  const left = mode === 'cost' ? 54 : 46;
  const plotWidth = Math.max(100, width - left - 12);
  const step = plotWidth / Math.max(1, days.length);
  const barWidth = Math.max(2, step * 0.68);
  const base = 210;
  const plotHeight = 178;
  const x = (i: number) => left + step * (i + 0.5);
  const y = (v: number) => base - (v / max) * plotHeight;
  const selected = hover == null ? null : days[hover];
  const change = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setHover(null);
  };
  const labelEvery = Math.max(1, Math.ceil((days.length - 1) / (width < 450 ? 2 : 4)));

  return (
    <section className="panel chart-panel usage-chart-panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Usage over time</h2>
          <p className="muted">
            {mode === 'tokens' ? 'Daily tokens by model' : 'Daily estimated API cost'} · Local dates
          </p>
        </div>
        <div className="chart-actions">
          <div className="segmented" aria-label="Chart measurement">
            <button
              aria-pressed={mode === 'tokens'}
              className={mode === 'tokens' ? 'active' : ''}
              onClick={() => change(setMode, 'tokens')}
            >
              Tokens
            </button>
            <button
              aria-pressed={mode === 'cost'}
              className={mode === 'cost' ? 'active' : ''}
              onClick={() => change(setMode, 'cost')}
            >
              Cost
            </button>
          </div>
          <select
            aria-label="Chart period"
            value={period}
            onChange={(e) => change(setPeriod, Number(e.target.value))}
          >
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
          </select>
        </div>
      </div>
      <div className="chart-filter-row">
        <label>
          Model
          <select
            aria-label="Chart model"
            value={activeId}
            onChange={(e) => change(setModelId, e.target.value)}
          >
            <option value="all">All models</option>
            {data.models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelLabel(m.model ?? m.name)}
                {data.models.filter((other) => other.name === m.name).length > 1
                  ? ` · ${m.source}`
                  : ''}
              </option>
            ))}
          </select>
        </label>
        <strong>
          {mode === 'tokens'
            ? `${compact(total)} tokens`
            : known
              ? `${money(total)}${unpricedDays ? '+' : ''}`
              : 'Unpriced'}
        </strong>
      </div>
      {mode === 'cost' && unpricedDays > 0 && (
        <p className="chart-pricing-note">
          <i className="unpriced-key" />
          <span>
            {known ? 'Partial estimate.' : 'No prices available for this usage.'}{' '}
            <b>
              {unpricedDays} {unpricedDays === 1 ? 'day has' : 'days have'} unpriced usage.
            </b>{' '}
            Token counts are available.
          </span>
        </p>
      )}
      <div className="chart-wrap daily-chart" ref={wrap}>
        {selected && (
          <div
            className="chart-tooltip daily-tooltip"
            style={{
              left: `${Math.max(100, Math.min(width - 100, x(hover ?? 0)))}px`,
            }}
          >
            <span>{shortDate(selected.date)}</span>
            <strong>{dayText(selected, mode)}</strong>
            {mode === 'cost' && (selected.unpricedEvents ?? 0) > 0 && (
              <small>{number(selected.unpricedEvents)} events have no price</small>
            )}
            {activeId === 'all' &&
              mode === 'tokens' &&
              series
                .filter((m) => (m.byDay.get(selected.date)?.tokens ?? 0) > 0)
                .map((m) => (
                  <small key={m.id}>
                    <i style={{ background: modelColor(m.model ?? m.name) }} />
                    {modelLabel(m.model ?? m.name)}{' '}
                    <b>{compact(m.byDay.get(selected.date)?.tokens)}</b>
                  </small>
                ))}
          </div>
        )}
        <svg
          className="timeline daily-timeline"
          viewBox={`0 0 ${width} 250`}
          role="group"
          aria-label={`${mode === 'tokens' ? 'Tokens' : 'Estimated cost'} by day · ${selectedModel ? modelLabel(selectedModel.model ?? selectedModel.name) : 'All models'}`}
        >
          <defs>
            <pattern
              id="unpriced-hatch"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(35)"
            >
              <line x1="0" y1="0" x2="0" y2="6" stroke="#d2a254" strokeWidth="1" opacity=".32" />
            </pattern>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line
                x1={left}
                x2={width - 12}
                y1={y((max * i) / 4)}
                y2={y((max * i) / 4)}
                className="grid-line"
              />
              <text x={left - 8} y={y((max * i) / 4) + 4} textAnchor="end">
                {mode === 'tokens'
                  ? compact((max * i) / 4)
                  : !known && unpricedDays > 0
                    ? i === 0
                      ? '$0'
                      : ''
                    : money((max * i) / 4).replace(/\.00$/, '')}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            let stack = 0;
            const unpriced = mode === 'cost' && (d.unpricedEvents ?? 0) > 0;
            const chunks: Array<{
              m: Pick<ModelUsage, 'id' | 'name'> & Partial<Pick<ModelUsage, 'model'>>;
              value: number;
            }> = series
              .map((m) => ({ m, value: m.byDay.get(d.date)?.[mode] }))
              .filter(
                (chunk): chunk is { m: (typeof series)[number]; value: number } =>
                  typeof chunk.value === 'number' && chunk.value > 0,
              );
            // Older readers still have aggregate days; keep their recorded values visible.
            const aggregate = d[mode];
            if (!chunks.length && aggregate !== null && aggregate > 0)
              chunks.push({
                m: { id: 'aggregate', name: 'Recorded usage' },
                value: aggregate,
              });
            return (
              <g key={d.date}>
                {hover === i && (
                  <rect
                    x={x(i) - step / 2}
                    y="26"
                    width={step}
                    height={plotHeight + 10}
                    fill="var(--chart-hover, #ece9f7)"
                    opacity=".55"
                  />
                )}
                {unpriced && (
                  <rect
                    x={x(i) - barWidth / 2}
                    y="32"
                    width={barWidth}
                    height={plotHeight}
                    fill="url(#unpriced-hatch)"
                  />
                )}
                {chunks.map(({ m, value }) => {
                  stack += value;
                  return (
                    <rect
                      key={m.id}
                      data-model={m.model ?? m.name}
                      x={x(i) - barWidth / 2}
                      y={y(stack)}
                      width={barWidth}
                      height={Math.max(0.6, (value / max) * plotHeight)}
                      fill={modelColor(m.model ?? m.name)}
                    >
                      <title>{`${modelLabel(m.model ?? m.name)}: ${mode === 'tokens' ? `${number(value)} tokens` : money(value)}`}</title>
                    </rect>
                  );
                })}
                {unpriced ? (
                  <path d={`M${x(i)},${base - 4} l4,4 -4,4 -4,-4 Z`} fill="#b57e27" />
                ) : d[mode] === 0 ? (
                  <line
                    x1={x(i) - barWidth / 2}
                    x2={x(i) + barWidth / 2}
                    y1={base}
                    y2={base}
                    stroke="#b7bfd0"
                    strokeWidth="2"
                  />
                ) : null}
                {(i === 0 ||
                  i === days.length - 1 ||
                  (i % labelEvery === 0 && i < days.length - 2)) && (
                  <text x={x(i)} y="240" textAnchor="middle">
                    {shortDate(d.date)}
                  </text>
                )}
                <rect
                  className="day-target"
                  x={x(i) - step / 2}
                  y="26"
                  width={step}
                  height={plotHeight + 20}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${shortDate(d.date)}: ${dayText(d, mode)}${unpriced ? `; ${number(d.unpricedEvents)} unpriced events` : ''}`}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => setHover(i)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setHover(null);
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setHover(i);
                    }
                  }}
                />
              </g>
            );
          })}
        </svg>
        {!days.some((d) => (d.tokens ?? 0) > 0 || (d.cost ?? 0) > 0 || (d.events ?? 0) > 0) && (
          <p className="chart-empty">No recorded usage in this period.</p>
        )}
      </div>
      <div className="chart-model-legend">
        {models.map((m) => (
          <span key={m.id}>
            <i className="legend-dot" style={{ background: modelColor(m.model ?? m.name) }} />
            {modelLabel(m.model ?? m.name)}
          </span>
        ))}
        {mode === 'cost' && unpricedDays > 0 && (
          <span>
            <i className="unpriced-key" />
            Unpriced usage
          </span>
        )}
      </div>
      <div className="chart-footer">
        <span>
          {days.length}
          {' days · '}
          {mode === 'tokens'
            ? 'Includes cached and reasoning tokens'
            : unpricedDays
              ? 'Shaded days have unknown costs'
              : 'Estimated from recorded usage'}
        </span>
        <span>
          {selectedModel ? modelLabel(selectedModel.model ?? selectedModel.name) : 'All models'}
        </span>
      </div>
      <details className="chart-values">
        <summary>View daily values</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Tokens</th>
                <th>Estimated cost</th>
                <th>Unpriced events</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td>{shortDate(d.date)}</td>
                  <td>{number(d.tokens)}</td>
                  <td>{costText(d)}</td>
                  <td>{number(d.unpricedEvents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
