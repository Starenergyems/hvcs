---
name: hvcs-power-analyze-day
description: Run the repository-local daily HVCS PowerAnalyze extraction flow that navigates to 需量分析, selects 每15分鐘, queries one target day, and writes artifacts/hvcs-power-analyze-day/<electric-number>/<YYYY-MM-DD>.json. Use when the user asks for a single-day power-analyze export, a day profile, or to re-run the PowerAnalyze session for a specific date.
---

# HVCS Power Analyze Day

## Overview
Run `npm run hvcs:power:day` in this repository, monitor live progress from `logs/headless/*.progress.json` or `npm run hvcs:watch`, and verify the daily output at `artifacts/hvcs-power-analyze-day/<electric-number>/<YYYY-MM-DD>.json`.

## Workflow
1. Confirm working directory is this repo (`/home/ubuntu/wt-hvcs-headless/hvcs-headless`).
2. Optionally set `HVCS_POWER_ANALYZE_DATE` in `.env` or inline as `YYYY-MM-DD`.
3. Run `npm run hvcs:power:day`.
4. Immediately follow live progress with `npm run hvcs:watch` or by reading the newest `logs/headless/*.progress.json` file and report stage changes back to the user while the run is active.
5. If progress reaches `auth_required`, tell the user to connect to the temporary noVNC session, complete captcha/login, and let the run continue.
6. Verify output file exists and is valid JSON.

## Runtime behavior
- Navigates to `https://service.taipower.com.tw/hvcs/Customer/Module/PowerAnalyze`.
- Ensures `每15分鐘` view.
- Queries the designated day, or yesterday if `HVCS_POWER_ANALYZE_DATE` is unset.
- Rejects future dates.
- If render/date validation fails, the output still records the requested day with `series: []`.

## Output Contract
Primary artifact:
- `artifacts/hvcs-power-analyze-day/<electric-number>/<YYYY-MM-DD>.json`

Expected top-level keys:
- `updated_at`
- `section`
- `granularity`
- `target_date`
- `page_url`
- `title`
- `series`

For `target_date`:
- `gregorian`
- `roc`

For each item in `series`:
- `category`
- `series_data` (`time` + `value` pairs)

Do not add extra sections unless the user asks.

## Live Progress
- Prefer reporting progress from the structured progress file over parsing plain-text logs.
- Important stages to relay: `starting`, `xvfb_ready`, `checking_auth`, `auth_required`, `auth_refreshed`, `navigating`, `completed`, `failed`
