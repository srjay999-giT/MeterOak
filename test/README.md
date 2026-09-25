# Browser checks

These scripts use Playwright Chromium in isolated temporary profiles. They do not attach to the user's browser or change saved site settings. All generated profiles, downloads, traces, reports, and screenshots stay inside the TOK workspace (`.qa-tmp/` and `.qa/`).

Start MeterOak with `npm start`, then run these commands from `MeterOak/`:

```sh
node test/browser-audit.mjs
node test/browser-intro.mjs
# Or check the existing production build without depending on a dev server:
node test/browser-intro.mjs --build
node test/browser-parity.mjs --output ../.qa/before
# After a refactor, with the same browser and OS:
node test/browser-parity.mjs --output ../.qa/after --compare ../.qa/before
```

Each script accepts `--url http://127.0.0.1:4520` and `--output <directory>`. Only localhost port 4520 is accepted. The functional audit also accepts `--snapshot <json-file>`. Do not use real credentials or private browser profiles.

Playwright is a local development dependency. Install its browser inside the project:

```sh
TMPDIR="$PWD/../.qa-tmp" PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright" node node_modules/playwright/cli.js install chromium
```

The scripts use `.playwright/` by default. `PLAYWRIGHT_MODULE` can explicitly select another installation when needed; the tests have no machine-specific fallback paths. An explicit `PLAYWRIGHT_BROWSERS_PATH` overrides the default.

## Reproducible data

`fixtures/dashboard.json` is a frozen September 25, 2026 API response. Session identifiers, workspace paths, and task labels have been replaced with stable test values. Unused historical limit arrays are omitted; the latest limit records remain. Token counts, prices, dates, models, source health, and record relationships are preserved for numerical regression checks. This fixture is historical test data, not current provider pricing or a verified invoice.

Dashboard API calls are intercepted with this fixture. External requests are blocked. Functional and screenshot checks request reduced motion, so they do not wait through the ten-second brand intro on every navigation. The separate intro test exercises real-time timing and reduced-motion behavior.

## Functional audit

`browser-audit.mjs` checks:

- Overview totals, all token categories, model allocation, session values, daily charts, and saved price disclosures against independent expectations from the fixture.
- All six pages; source, model, and period filters; model sorting and search; session pagination and dialogs; CSV downloads.
- Budget validation, source isolation, persistence, warnings, and cleanup.
- Original and Portfolio theme persistence and chart identity colors.
- Partial scans, missing sources, unknown prices, partially priced sessions, reader outage, retry, and recovery.
- Both themes across 319, 390, 640, 641, 768, 1024, and 1600px; viewport overflow; mobile drawer close, scrim, and Escape behavior.
- Unexpected browser JavaScript errors.

It produces a JSON/Markdown report, browser trace, representative/failure screenshots, and CSV downloads. Intentional 503 responses are labeled separately from unexpected errors. A failed assertion gives a nonzero exit status. Expected values do not reuse the application formatting or aggregation helpers.

## Visual parity

`browser-parity.mjs` captures all six pages in both themes at 1600px desktop and 390px mobile: 24 full-page images. The date, API response, locale, timezone, reduced-motion preference, and viewport are fixed. Comparison is exact PNG equality; use the same browser version and OS fonts for both runs. The report also records the visible page text and fixture hash.

For the documented hidden-table-label overflow correction, `--allow-overflow-fix` permits the image width to shrink to the viewport only when its height and every visible pixel remain identical. It does not permit arbitrary visual differences.

## Loading screen

`browser-intro.mjs` checks the approximately ten-second opening and reload, percentage/dot agreement, keyboard inert state, prompt opening for reduced motion, four responsive viewport sizes, no replay during page navigation, slow-reader deadline, and failed-bundle retry state. Timing windows include a small allowance for browser scheduling; the percentage represents the brand entrance rather than measured data download progress. `--build` serves the existing `dist/` assets through browser request interception, and `--compare <earlier-intro.json>` compares the loader's placement, dimensions, colors, and fonts against a previous run.

## Limits

These tests cover Chromium, not Firefox, WebKit, or Selenium. Frozen-data checks establish regression behavior only: they cannot prove that upstream tools logged every event, that historical prices are current, or that an API-equivalent estimate equals a paid bill.

## Laptop and phone layout

`browser-responsive.mjs` captures all six pages in both appearances at 1280×720, 1440×800, 1600×1000, 390×844, and 320×700. It checks the header gap, viewport width, primary mobile control sizes, access to the bottom of the page and sidebar, and actual horizontal scrolling of wide tables. It also records DOM dimensions alongside each screenshot.

```sh
node test/browser-responsive.mjs --output ../.qa/responsive-after --compare ../.qa/responsive-before
```

`--compare` is optional and checks that visible main content is unchanged from the earlier `measurements.json`. `--measure-only` records any failed constraints without a failing exit status, for capturing a pre-change baseline. Screenshots and temporary profiles stay inside TOK, as with the other checks.
