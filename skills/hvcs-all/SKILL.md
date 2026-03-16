---
name: hvcs-all
description: Run the repository-local combined HVCS headless flow that executes basic:all and monthly PowerAnalyze in one live browser session, reports progress from logs/headless/*.progress.json, and writes artifacts under artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json and artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json. Use when the user wants to minimize repeated captcha/login by running both flows in one session.
---

# HVCS All

## Overview
Run `npm run hvcs:all` in this repository, monitor live progress from `logs/headless/*.progress.json` or `npm run hvcs:watch`, and verify that both managed artifacts are written from the same live browser session:

- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`
- `artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json`

## Workflow
1. Confirm working directory is this repo (`/home/ubuntu/wt-hvcs-headless/hvcs-headless`).
2. Optionally set `HVCS_POWER_ANALYZE_MONTH` in `.env` or inline as `YYYY-MM`.
3. Run `npm run hvcs:all`.
4. Immediately follow live progress with `npm run hvcs:watch` or by reading the newest `logs/headless/*.progress.json` file and report stage changes back to the user while the run is active.
5. If progress reaches `auth_required`, tell the user to connect to the temporary noVNC session, complete captcha/login, and let the run continue.
6. Wait for the combined flow to pass through the intermediate `combined_next` stage, which means `basic:all` finished and the same session is continuing into monthly PowerAnalyze.
7. Verify both artifacts exist and are valid JSON.

## Live Progress
- Prefer reporting progress from the structured progress file over parsing plain-text logs.
- Important stages to relay: `starting`, `xvfb_ready`, `checking_auth`, `auth_required`, `auth_refreshed`, `navigating`, `combined_next`, `querying_month_day`, `completed`, `failed`
- `combined_next` means the first artifact was saved and the same browser session is continuing into the monthly PowerAnalyze flow.

## Validation Checks
After running, inspect both artifacts and confirm:
- the basic-all artifact has top-level `updated_at`, `basic`, `energy_usage`, and `price`
- the monthly artifact has top-level `updated_at`, `section`, `granularity`, `target_month`, `page_url`, `title`, and `daily`
- both artifact paths use the same electric number
- the run did not require a second login between the `basic:all` and monthly PowerAnalyze phases

## Output Contract
Primary artifacts:
- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`
- `artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json`

Do not create extra JSON files for this flow unless the user asks.
