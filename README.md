<p align="center">
  <img src="public/meteroak-mark.svg" alt="MeterOak logo" width="72" height="72">
</p>

<h1 align="center">MeterOak</h1>

<p align="center"><strong>Bringing your usage in focus.</strong></p>
<p align="center">A local dashboard for AI coding usage, tokens, cache efficiency, and API cost estimates.</p>

<p align="center">
  <a href="https://srjay999-git.github.io/MeterOak/">Live demo</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#privacy-and-storage">Privacy</a> ·
  <a href="#quick-intro">Quick intro</a>
</p>

![MeterOak usage overview in Portfolio mode](docs/screenshots/overview-hero.png)

<p align="center"><sub>Portfolio mode · Sanitized example records · Dollar values are estimates, not a bill.</sub></p>

## Quick intro

https://github.com/user-attachments/assets/2145c51b-0307-4a2f-9bcf-5fcaba363ccc

**Currently supports Codex and OpenCode only.** No MeterOak account, API key, or billing connection is required.

## Live demo

**[Try MeterOak in your browser →](https://srjay999-git.github.io/MeterOak/)**

Explore all six pages, filters, session details, budgets, and CSV export without installing anything. The demo uses a fixed, sanitized example snapshot in Portfolio mode. It cannot read your files, AI accounts, or billing records. Demo preferences stay in your browser, and its dollar amounts are illustrative estimates.

To see **your own usage**, run MeterOak locally using the steps below.

## Inside the dashboard

| Page | What it shows |
| --- | --- |
| **Overview** | Token totals, cache reuse, daily trends, model allocation, and known API-equivalent cost. |
| **Models** | Usage and cost by model, with search, sorting, and missing-price visibility. |
| **Session history** | Searchable sessions, token breakdowns, details, and CSV export. |
| **Budgets** | Browser-saved targets and threshold warnings. These do not limit or stop usage. |
| **Insights** | Usage patterns, cache efficiency, cost coverage, and a 30-day API-equivalent cost run rate. |
| **Connections** | Local source availability, scan diagnostics, and recorded usage-limit snapshots. |

Portfolio is the default; Original is available in the appearance selector. Both support desktop and mobile, combined/per-source views, and 10-second data refreshes.

## Quickstart

Requires **Node.js 24.2+**, npm, and local usage records from Codex or OpenCode.
From the MeterOak project directory:

```sh
npm ci
npm start
```

Open **[localhost:4520](http://localhost:4520/)**. The launcher starts Vite on port `4520` and the reader on `4491`, both bound to `127.0.0.1`. Stop with **Ctrl+C**. Opening `index.html` directly will not work.

Check **Connections** for missing sources or scan issues. No sample data replaces missing local records.

## How it works

```text
Codex JSONL logs ─────┐
                     ├─→ Local Node.js reader → localhost API → React dashboard
OpenCode SQLite DB ──┘
```

- **Codex:** reads `$CODEX_HOME/sessions`, or `~/.codex/sessions` by default. JSONL files are read in 64 KB chunks; malformed or oversized records are reported.
- **OpenCode:** opens SQLite **read-only**, using `OPENCODE_DB` or detected data directories, typically `~/.local/share/opencode/opencode.db`. See [source discovery](server/adapters.mjs) for platform fallbacks.
- **Accounting:** normalizes timestamps, models, and token counters; handles cumulative counters and overlapping session files; aggregates **30 local calendar days**. Charts offer 7-, 14-, and 30-day views.

Model names come from recorded metadata; missing models stay unknown. Unreadable files, incomplete scans, and missing prices are disclosed. Totals depend on the records available locally.

## Privacy and storage

**Your usage stays on your machine. MeterOak does not upload it to a hosted MeterOak service.**

| Data | Where it lives |
| --- | --- |
| Original usage history | Codex files and OpenCode's database on your device; MeterOak does not modify them. |
| Parsed usage and aggregates | The local Node.js process's in-memory cache. |
| Appearance and budget preferences | This browser's `localStorage`. |
| Model prices | The project's local [pricing table](server/pricing.json). |

There is **no MeterOak persistent database or cloud account store**. The local session-detail API can include tool arguments/results; keep the reader accessible only on your own machine.

## Tokens and cost estimates

Token categories do not overlap: cached input is separated from fresh input, and reasoning from output, before totals are added.

Source-reported costs are retained. Otherwise, each usage event uses saved model rates in USD per million tokens:

```text
estimate = (fresh input × input rate
          + cache reads × cache-read rate
          + cache writes × cache-write rate
          + (output + reasoning) × output rate) ÷ 1,000,000
```

Configured long-context rates apply when request size is known. **Unpriced** events still count toward tokens. Saved prices do not update automatically.

**Estimates are not bills.** They exclude subscriptions, Fast-mode premiums, Batch/Flex discounts, tool fees, regional surcharges, and taxes. Actual paid charges require billing records.

## Technology

| Layer | Technology |
| --- | --- |
| Frontend | React 19, strict TypeScript, Vite 8, plain CSS, custom SVG charts and icons. |
| Backend | Node.js 24.2+, JavaScript ES modules, native HTTP and filesystem APIs. |
| Data access | Chunked JSONL parsing; Node's built-in `node:sqlite` for read-only OpenCode access. |
| Storage | Source files/databases, an in-memory reader cache, and browser `localStorage` for preferences. |
| Quality checks | Node's test runner, TypeScript checks, Playwright Chromium, and Prettier. |

## Roadmap

Planned integrations: **Claude Code, Cursor, Antigravity, Devin, and more AI IDEs and coding agents**. These are future goals; current support remains **Codex and OpenCode only**.

## Development

```sh
npm run build          # Type-check and create dist/
npm run build:demo     # Build the static sample demo in dist-demo/
npm test               # Reader, accounting, and frontend data tests
npm run format:check   # Check source formatting
```

See [browser checks](test/README.md) for isolated Playwright coverage of navigation, calculations, exports, responsive layouts, and the opening animation.

## License

[MIT](LICENSE). Retain the included copyright and license notices when redistributing.
