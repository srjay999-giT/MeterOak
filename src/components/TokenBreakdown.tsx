import { compact, number } from '../data';
import type { Dashboard } from '../types';
import { Icon } from './Icon';

const colors = [
  'var(--token-input, #6556db)',
  'var(--token-read, #7c9bec)',
  'var(--token-output, #59b8ac)',
  'var(--token-reasoning, #c4a1df)',
  'var(--token-write, #dea47f)',
];
const percent = (part: number | null, total: number) =>
  total > 0 && part != null ? Math.min(100, (part / total) * 100) : 0;

export function TokenBreakdown({ data }: { data: Dashboard }) {
  const t = data.totals;
  const categories: Array<[string, number | null, string]> = [
    ['Input', t.input, colors[0]],
    ['Cache read', t.cacheRead, colors[1]],
    ['Output', t.output, colors[2]],
    ['Reasoning', t.reasoning, colors[3]],
    ['Cache write', t.cacheWrite, colors[4]],
  ];
  const total = categories.reduce((sum, [, v]) => sum + (v || 0), 0);
  let cursor = 0;
  const gradient = categories
    .map(([, v, color]) => {
      let start = cursor;
      cursor += percent(v, total);
      return `${color} ${start}% ${cursor}%`;
    })
    .join(',');
  return (
    <section className="panel token-panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Token breakdown</h2>
          <p className="muted">Every part of your context</p>
        </div>
        <Icon name="chip" />
      </div>
      <div className="token-body">
        <div
          className="donut"
          style={{ background: total ? `conic-gradient(${gradient})` : '#e8eaf0' }}
          role="img"
          aria-label={`${number(t.tokens)} total tokens`}
        >
          <div>
            <strong>{compact(t.tokens)}</strong>
            <span>total tokens</span>
          </div>
        </div>
        <div className="token-legend">
          {categories.map(([label, value, color]) => (
            <div key={label}>
              <span>
                <i className="legend-dot" style={{ background: color }} />
                {label}
              </span>
              <strong>{compact(value)}</strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
