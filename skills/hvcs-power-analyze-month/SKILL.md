---
name: hvcs-power-analyze-month
description: Run the repository-local monthly HVCS PowerAnalyze extraction flow that navigates to 需量分析, selects 每15分鐘, iterates daily queries for one month, and writes artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json. Use when the user asks for monthly power-analyze export, per-day iteration, or handling timeout/no-render as empty series.
---

# HVCS Power Analyze Month

## Overview
Run `npm run open:power-analyze-month` in this repository and verify the monthly output at `artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json`.

## Workflow
1. Confirm working directory is this repo (`/home/ubuntu24/hvcs-login`).
2. Optionally set `HVCS_POWER_ANALYZE_MONTH` in `.env` or inline as `YYYY-MM`.
3. Run `npm run open:power-analyze-month`.
4. Wait for manual browser steps when login/captcha is required.
5. Verify output file exists and is valid JSON.

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
