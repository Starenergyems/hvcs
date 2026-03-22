---
name: hvcs-all-range
description: Run the repository-local combined HVCS headless flow that saves hvcs-basic-all first and then extracts an exact PowerAnalyze date range into artifacts/hvcs-power-analyze-range/<electric-number>/<start>_to_<end>.json in the same browser session. Use when the user wants one login/captcha flow for both basic settlement tables and a specific daily profile window such as a billing-period slice.
---

# HVCS All Range

## Overview
Run `npm run hvcs:all:range` in this repository, monitor live progress from `logs/headless/*.progress.json` or `npm run hvcs:watch`, and verify that both managed artifacts are written from the same live browser session:

- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`
- `artifacts/hvcs-power-analyze-range/<electric-number>/<YYYY-MM-DD>_to_<YYYY-MM-DD>.json`

## Sandbox Requirement
- This flow launches Xvfb, Playwright Chromium, x11vnc, and noVNC. In the Codex sandbox, request escalated execution before starting it.
- If a prior attempt already failed with browser launch, display bind, or `Operation not permitted` errors, do not retry sandboxed.

## Workflow
1. Confirm working directory is this repo (`/home/ubuntu/wt-settlement/hvcs-headless`).
2. Set `HVCS_POWER_ANALYZE_START_DATE` and `HVCS_POWER_ANALYZE_END_DATE` inline as `YYYY-MM-DD`.
3. Run `npm run hvcs:all:range`.
4. Follow the newest `logs/headless/*.progress.json` file and proactively report stage changes while the run is active.
5. If progress reaches `auth_required`, tell the user to connect to the temporary noVNC session, complete captcha/login, and let the run continue.
6. Wait for `combined_next`, which means `basic:all` finished and the same session is continuing into PowerAnalyze.
7. Verify both artifacts exist and are valid JSON.

## Live Progress
- Prefer the structured progress file over plain-text logs.
- Important stages to relay: `starting`, `xvfb_ready`, `checking_auth`, `auth_required`, `auth_refreshed`, `navigating`, `combined_next`, `querying_range_day`, `completed`, `failed`
- During `querying_range_day`, periodically report the current date being processed.

## Validation Checks
After running, confirm:
- the basic-all artifact has top-level `updated_at`, `basic`, `energy_usage`, and `price`
- the range artifact has top-level `updated_at`, `section`, `granularity`, `target_range`, `page_url`, `title`, and `daily`
- both artifact paths use the same electric number
- the run did not require a second login between the `basic:all` and exact-range PowerAnalyze phases

## Continuation Rule
- If the same user request also asks for downstream work after extraction, do not stop at artifact verification.
- Keep monitoring until the run reaches `completed`, then immediately continue into the requested follow-up work in the same turn.
- Typical follow-up work includes bill inspection, settlement comparison, config sync, and plan updates.
- Only stop early if there is a real blocker such as `auth_required`, a failed run, or missing artifacts.

## Output Contract
Primary artifacts:
- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`
- `artifacts/hvcs-power-analyze-range/<electric-number>/<YYYY-MM-DD>_to_<YYYY-MM-DD>.json`

Do not create extra JSON files for this flow unless the user asks.
