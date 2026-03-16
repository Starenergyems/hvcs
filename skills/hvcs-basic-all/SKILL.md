---
name: hvcs-basic-all
description: Run the repository-local HVCS one-shot extraction flow that navigates 用戶資料, 用電紀錄, and 電費紀錄 and writes a managed artifact at artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json. Use when the user asks to run, regenerate, or verify the basic:all export, or when they report mismatched fields in basic/energy_usage/price data.
---

# HVCS Basic All

## Overview
Run `npm run hvcs:basic:all` in this repository, monitor live progress from `logs/headless/*.progress.json` or `npm run hvcs:watch`, and then verify `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json` contains only the three required datasets: `basic`, `energy_usage`, and `price`.

## Workflow
1. Confirm working directory is this repo (`/home/ubuntu/wt-hvcs-headless/hvcs-headless`).
2. Run `npm run hvcs:basic:all`.
3. Immediately follow live progress with `npm run hvcs:watch` or by reading the newest `logs/headless/*.progress.json` file and report stage changes back to the user while the run is active.
4. If progress reaches `auth_required`, tell the user to connect to the temporary noVNC session, complete captcha/login, and let the run continue.
5. Verify `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json` exists.
6. Validate JSON shape:
- top-level key `updated_at` is an ISO-8601 UTC timestamp for the latest artifact write
- top-level keys: `basic`, `energy_usage`, `price`
- each key maps to an array
- no extra top-level keys unless explicitly requested by the user

## Live Progress
- Prefer reporting progress from the structured progress file over parsing plain-text logs.
- Important stages to relay: `starting`, `xvfb_ready`, `checking_auth`, `auth_required`, `auth_refreshed`, `navigating`, `completed`, `failed`
- If the run is using the combined flow or any future multi-step flow, also relay intermediate stages like `combined_next` and `querying_month_day`.

## Validation Checks
After running, inspect `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json` and confirm:
- `basic` contains sections from 用戶資料 tables (for example: 基本資料, 設備容量, 契約容量)
- `energy_usage` uses month-grouped records
- `price` contains 電費紀錄 table rows
- `selected-year` comes from the year selector shown on 用電紀錄/電費紀錄

If the user reports field mismatches:
1. Recheck whether the source row is affected by merged cells (`rowspan`/`colspan`).
2. Update extraction normalization in `scripts/extract-dashboard.js`.
3. Re-run `npm run hvcs:basic:all` and compare output against the reported row.

## Output Contract
Primary artifact:
- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`

Do not create extra JSON files for this flow unless the user asks.
