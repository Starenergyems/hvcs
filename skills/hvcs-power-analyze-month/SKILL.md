---
name: hvcs-power-analyze-month
description: Run the repository-local monthly HVCS PowerAnalyze extraction flow that navigates to 需量分析, selects 每15分鐘, iterates daily queries for one month, and writes artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json. Use when the user asks for monthly power-analyze export, per-day iteration, or handling timeout/no-render as empty series.
---

# HVCS Power Analyze Month

## Overview
Run `npm run hvcs:power:month` in this repository, monitor live progress from `logs/headless/*.progress.json` or `npm run hvcs:watch`, and verify the monthly output at `artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json`.

## Workflow
1. Confirm working directory is this repo (`/home/ubuntu/wt-hvcs-headless/hvcs-headless`).
2. Optionally set `HVCS_POWER_ANALYZE_MONTH` in `.env` or inline as `YYYY-MM`.
3. Run `npm run hvcs:power:month`.
4. Immediately follow live progress with `npm run hvcs:watch` or by reading the newest `logs/headless/*.progress.json` file and report stage changes back to the user while the run is active.
5. If progress reaches `auth_required`, tell the user to connect to the temporary noVNC session, complete captcha/login, and let the run continue.
6. Verify output file exists and is valid JSON.

## Runtime behavior
- Navigates to `https://service.taipower.com.tw/hvcs/Customer/Module/PowerAnalyze`.
- Ensures `每15分鐘` view.
- Iterates one query per day for the target month.
- Caps iteration at yesterday (no future-date queries).
- If a day times out or render/date validation fails, that day is still recorded with `series: []`.

## Output Contract
Primary artifact:
- `artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json`

Expected top-level keys:
- `updated_at`
- `section`
- `granularity`
- `target_month`
- `page_url`
- `title`
- `daily`

For each item in `daily`:
- `target_date` with `gregorian` and `roc`
- `series` array where each series includes:
- `category`
- `series_data` (`time` + `value` pairs)

Do not add extra sections unless the user asks.

## Live Progress
- Prefer reporting progress from the structured progress file over parsing plain-text logs.
- Important stages to relay: `starting`, `xvfb_ready`, `checking_auth`, `auth_required`, `auth_refreshed`, `navigating`, `querying_month_day`, `completed`, `failed`
