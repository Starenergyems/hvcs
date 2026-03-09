---
name: hvcs-basic-all
description: Run the repository-local HVCS one-shot extraction flow that navigates 用戶資料, 用電紀錄, and 電費紀錄 and writes a single output/basic_all.json file. Use when the user asks to run, regenerate, or verify the basic:all export, or when they report mismatched fields in basic/energy_usage/price data.
---

# HVCS Basic All

## Overview
Run `npm run basic:all` in this repository, then verify `output/basic_all.json` contains only the three required datasets: `basic`, `energy_usage`, and `price`.

## Workflow
1. Confirm working directory is this repo (`/home/ubuntu24/hvcs-login`).
2. Run `npm run basic:all`.
3. Wait for manual browser steps when login/captcha is required.
4. Verify `output/basic_all.json` exists.
5. Validate JSON shape:
- top-level keys: `basic`, `energy_usage`, `price`
- each key maps to an array
- no extra top-level keys unless explicitly requested by the user

## Validation Checks
After running, inspect `output/basic_all.json` and confirm:
- `basic` contains sections from 用戶資料 tables (for example: 基本資料, 設備容量, 契約容量)
- `energy_usage` uses month-grouped records
- `price` contains 電費紀錄 table rows

If the user reports field mismatches:
1. Recheck whether the source row is affected by merged cells (`rowspan`/`colspan`).
2. Update extraction normalization in `scripts/extract-dashboard.js`.
3. Re-run `npm run basic:all` and compare output against the reported row.

## Output Contract
Primary artifact:
- `output/basic_all.json`

Do not create extra JSON files for this flow unless the user asks.
