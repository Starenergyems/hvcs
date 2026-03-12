---
name: hvcs-power-analyze-day
description: Run the repository-local daily HVCS PowerAnalyze extraction flow that navigates to 需量分析, selects 每15分鐘, queries one target day, and writes output/power-analyze.json. Use when the user asks for a single-day power-analyze export, a day profile, or to re-run the PowerAnalyze session for a specific date.
---

# HVCS Power Analyze Day

## Overview
Run `npm run open:power-analyze` in this repository and verify the daily output at `output/power-analyze.json`.

## Workflow
1. Confirm working directory is this repo (`/home/ubuntu24/hvcs-login`).
2. Optionally set `HVCS_POWER_ANALYZE_DATE` in `.env` or inline as `YYYY-MM-DD`.
3. Run `npm run open:power-analyze`.
4. Wait for manual browser steps when login/captcha is required.
5. Verify output file exists and is valid JSON.

## Runtime behavior
- Navigates to `https://service.taipower.com.tw/hvcs/Customer/Module/PowerAnalyze`.
- Ensures `每15分鐘` view.
- Queries the designated day, or yesterday if `HVCS_POWER_ANALYZE_DATE` is unset.
- Rejects future dates.
- If render/date validation fails, the output still records the requested day with `series: []`.

## Output Contract
Primary artifact:
- `output/power-analyze.json`

Expected top-level keys:
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
