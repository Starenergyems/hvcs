---
name: hvcs-all
description: Run the repository-local combined HVCS headless flow that executes basic:all and monthly PowerAnalyze in one live browser session, reports progress from logs/headless/*.progress.json, and writes artifacts under artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json and artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json. Use when the user wants to minimize repeated captcha/login by running both flows in one session. Because this flow launches Xvfb, Chromium, x11vnc, and noVNC, request escalated execution before starting it when running under the Codex sandbox.
---

# HVCS All

## Overview
Run `npm run hvcs:all` in this repository, monitor live progress from `logs/headless/*.progress.json` or `npm run hvcs:watch`, and verify that both managed artifacts are written from the same live browser session:

- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`
- `artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json`

## Sandbox Requirement
- This flow launches Xvfb, Playwright Chromium, x11vnc, and noVNC. In the Codex sandbox, browser or display startup may fail with permission-related errors unless the command is run with escalated execution.
- Before running `npm run hvcs:all`, request escalation instead of first attempting a sandboxed run.
- If a prior attempt already failed with browser launch, display bind, or `Operation not permitted` errors, do not retry sandboxed; rerun with escalation.

## Workflow
1. Confirm working directory is this repo (`/home/ubuntu/wt-hvcs-headless/hvcs-headless`).
2. Optionally set `HVCS_POWER_ANALYZE_MONTH` in `.env` or inline as `YYYY-MM`.
3. Run `npm run hvcs:all` with escalated execution when using Codex tooling.
4. Immediately follow live progress with `npm run hvcs:watch` or by reading the newest `logs/headless/*.progress.json` file and proactively report stage changes back to the user while the run is active. Do not wait for the user to ask for updates.
5. If progress reaches `auth_required`, tell the user the exact access steps for the temporary noVNC session:
   - run `ssh -L 6080:localhost:6080 ubuntu@<ec2-host>`
   - open `http://localhost:6080/vnc.html?autoconnect=1&resize=remote`
   - complete captcha/login in the remote browser and let the run continue automatically
6. Wait for the combined flow to pass through the intermediate `combined_next` stage, which means `basic:all` finished and the same session is continuing into monthly PowerAnalyze.
7. Verify both artifacts exist and are valid JSON.

## Live Progress
- Prefer reporting progress from the structured progress file over parsing plain-text logs.
- Important stages to relay: `starting`, `xvfb_ready`, `checking_auth`, `auth_required`, `auth_refreshed`, `navigating`, `combined_next`, `querying_month_day`, `completed`, `failed`
- `combined_next` means the first artifact was saved and the same browser session is continuing into the monthly PowerAnalyze flow.
- While the run is active, give the user concise progress updates whenever the stage changes and periodically during `querying_month_day` with the current date being processed.

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
