# HVCS login capture

This project contains a Playwright helper for the Taipower HVCS login flow at:

`https://service.taipower.com.tw/hvcs/`

## What the script does

- Opens the real HVCS login page in a headed Chromium browser
- Optionally pre-fills account and password from environment variables
- Leaves captcha and any human verification to the user
- Stores the authenticated browser session in:
  - `.auth/browser-profile/`
  - `.auth/storage-state.json`

## Why it is manual

The live site presents an on-page captcha on the login form, so a fully automated login would be brittle and likely fail. This script is designed to guide a human through authentication and persist the resulting browser state for later scraping or navigation.

## Deploy on headless AWS EC2

Yes, you can copy this repo to an AWS EC2 instance and run it there.

Treat the EC2 setup as "browser-assisted automation", not a fully hands-off batch worker:

- The code can be copied directly to EC2.
- The authenticated session should be created on EC2 by doing a fresh human login there.
- HVCS login still includes captcha / human verification, so expired sessions require a manual refresh.
- The current scripts launch Chromium with `headless: false`.
- On a plain server, the supported setup is a shared wrapper that starts Xvfb for every run and only starts VNC/noVNC when saved auth is invalid and a captcha/login is needed.

What to copy to EC2:

- the repo itself
- an `.env` template if you use one, but keep only the variable names and leave values empty

What to install on EC2:

- Node.js and `npm`
- project dependencies via `npm install`
- Playwright Chromium
- system libraries required by Playwright
- a virtual display / remote GUI path for on-demand login refresh

### 1) Copy the repo to EC2

From your local machine, copy the project to the instance:

```bash
scp -r /path/to/hvcs-headless ubuntu@<ec2-host>:/home/ubuntu/wt-hvcs-headless/
```

Or with `rsync`:

```bash
rsync -av /path/to/hvcs-headless/ ubuntu@<ec2-host>:/home/ubuntu/wt-hvcs-headless/hvcs-headless/
```

Then connect to the instance:

```bash
ssh ubuntu@<ec2-host>
cd /home/ubuntu/wt-hvcs-headless/hvcs-headless
```

### 2) Provision dependencies on EC2

```bash
sudo apt update
sudo apt install -y nodejs npm xvfb x11vnc novnc websockify openbox
npm install
npx playwright install chromium
sudo npx playwright install-deps chromium
chmod +x scripts/run-hvcs.sh scripts/manage-remote-display.sh
```

### 3) Prepare `.env` on EC2

Do not transfer `.auth/browser-profile/` or `.auth/storage-state.json` from another machine.

Instead, create or edit `.env` on EC2 with only the keys you want to keep, and leave the values empty until you are ready to fill them on that machine.

Example:

```dotenv
HVCS_ACCOUNT=
HVCS_PASSWORD=
HVCS_ELECTRIC_NUMBER=
HVCS_POWER_ANALYZE_DATE=
HVCS_POWER_ANALYZE_MONTH=
```

The login/session state will be created fresh on EC2 after the human login flow.

### 4) Run with the shared headless wrapper

The shared wrapper always starts Xvfb, runs the selected flow on `DISPLAY=:99`, and only starts x11vnc + noVNC if saved auth is invalid.

Logs are written under `logs/headless/`.

If auth is invalid, the log prints the noVNC tunnel instructions:

```bash
ssh -L 6080:localhost:6080 ubuntu@<ec2-host>
```

Then open:

```text
http://localhost:6080/vnc.html
```

Run the one-time login flow like this:

```bash
npm run hvcs:login
```

When captcha/login is required, connect through noVNC, finish login, and let the wrapper tear the remote-view stack down automatically after auth is saved.

In `--mode=headless`, that remote-view teardown only affects noVNC/x11vnc/openbox. The browser automation itself keeps running in Xvfb after auth is saved and continues the extraction flow.

### 5) Run extraction jobs on EC2

```bash
HVCS_ELECTRIC_NUMBER='your-electric-number' \
npm run hvcs:extract:dashboard
```

Set `HVCS_ELECTRIC_NUMBER` to avoid manual electric-number selection pauses.

Run the three managed artifact flows the same way:

Basic all:

```bash
HVCS_ELECTRIC_NUMBER='your-electric-number' \
HVCS_BASIC_ALL_YEAR=2025 \
npm run hvcs:basic:all
```

Power analyze day:

```bash
HVCS_ELECTRIC_NUMBER='your-electric-number' \
HVCS_POWER_ANALYZE_DATE=2026-03-11 \
npm run hvcs:power:day
```

Power analyze month:

```bash
HVCS_ELECTRIC_NUMBER='your-electric-number' \
HVCS_POWER_ANALYZE_MONTH=2026-03 \
npm run hvcs:power:month
```

Managed artifacts will be written to:

- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`
- `artifacts/hvcs-power-analyze-day/<electric-number>/<YYYY-MM-DD>.json`
- `artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json`

### 6) Refresh auth when session expires

If a scheduled job is redirected back to login, rerun the same wrapper command in `--mode=headless`. It will start noVNC only if the saved session is invalid and tear the remote-view stack down after the run.

## Headed vs headless recommendation

- `--mode=headed` runs on an existing desktop session.
- `--mode=headless` runs the same browser flow inside Xvfb.
- Remote viewing is started only on auth fallback.
- The wrapper tears remote viewing down automatically on success or failure.
- In `--mode=headless`, after auth is resolved the wrapper stops the temporary noVNC/x11vnc/openbox stack to save resources, but the browser automation continues inside Xvfb.
- In `--mode=headed`, there is no noVNC teardown step because the flow is already running on the existing desktop session; after auth is resolved, the browser just keeps going in that same headed desktop session.

## Install

```bash
npm install
npx playwright install chromium
```

## Run

Without pre-filled credentials:

```bash
npm run login
```

With account and password pre-filled:

```bash
HVCS_ACCOUNT='your-account' HVCS_PASSWORD='your-password' npm run login
```

After the browser opens:

1. Complete the captcha and any remaining login steps in the browser.
2. Wait until you can see a logged-in page.
3. Return to the terminal and press Enter.

## Reuse saved auth

Later Playwright scripts can reuse the saved state like this:

```js
const { chromium } = require("playwright");

const browser = await chromium.launch();
const context = await browser.newContext({
  storageState: ".auth/storage-state.json",
});
const page = await context.newPage();
await page.goto("https://service.taipower.com.tw/hvcs/");
```

## Extract the dashboard

The dashboard extractor can also handle login if the saved session has expired. It reuses the same persistent browser profile, lets you complete manual login if needed, and then continues to:

`用電管理 -> 選擇電號 -> 本日用電儀表板`

and save the rendered page data as JSON:

```bash
npm run extract:dashboard
```

If your account has multiple `電號`, you can target one explicitly:

```bash
HVCS_ELECTRIC_NUMBER='your-electric-number' npm run extract:dashboard
```

To land on `不同期間電費比較` instead of the dashboard:

```bash
HVCS_ELECTRIC_NUMBER='your-electric-number' npm run open:cycle
```

To land on `https://service.taipower.com.tw/hvcs/Customer/Module/Basic` (`用戶資訊`):

```bash
HVCS_ELECTRIC_NUMBER='your-electric-number' npm run open:basic
```

To open `用戶資訊 -> 電費紀錄`, extract the page data, and save as `output/price.*`:

```bash
npm run open:price
```

To open `用戶資訊 -> 用戶資料`, extract only table data, and save as `output/basic.*`:

```bash
npm run open:basic
```

To open `用戶資訊 -> 用電紀錄`, extract only table data, and save as `output/energy_usage.*`:

```bash
npm run open:energy_usage
```

To navigate to `需量分析 (PowerAnalyze)`, switch to `每15分鐘`, target a single day, and save a managed artifact under `artifacts/hvcs-power-analyze-day/<electric-number>/<YYYY-MM-DD>.json`:

```bash
npm run open:power-analyze
```

Optional target date for the single-day session (default is yesterday):

```bash
HVCS_POWER_ANALYZE_DATE=2026-03-11 npm run open:power-analyze
```

To iterate a full month on `需量分析 (PowerAnalyze) -> 每15分鐘` and save all daily series into `artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json`:

```bash
npm run open:power-analyze-month
```

Optional target month (default is yesterday's month):

```bash
HVCS_POWER_ANALYZE_MONTH=2026-03 npm run open:power-analyze-month
```

To iterate an exact date range on `需量分析 (PowerAnalyze) -> 每15分鐘` and save all daily series into `artifacts/hvcs-power-analyze-range/<electric-number>/<start>_to_<end>.json`:

```bash
HVCS_POWER_ANALYZE_START_DATE=2026-01-31 \
HVCS_POWER_ANALYZE_END_DATE=2026-02-27 \
npm run open:power-analyze-range
```

To run `用戶資料 + 用電紀錄 + 電費紀錄` in one shot and save:
- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`

```bash
HVCS_BASIC_ALL_YEAR=2025 \
npm run basic:all
```

To run `用戶資料 + 用電紀錄 + 電費紀錄` first and then extract an exact `需量分析 (PowerAnalyze) -> 每15分鐘` date range in the same session, saving both artifacts:
- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`
- `artifacts/hvcs-power-analyze-range/<electric-number>/<YYYY-MM-DD>_to_<YYYY-MM-DD>.json`

```bash
HVCS_BASIC_ALL_YEAR=2025 \
HVCS_POWER_ANALYZE_START_DATE=2026-01-31 \
HVCS_POWER_ANALYZE_END_DATE=2026-02-27 \
npm run open:all-range
```

`HVCS_BASIC_ALL_YEAR` is optional. When set, the extractor switches the `用電紀錄 / 電費紀錄` year selector before saving `hvcs-basic-all`, which is required for older bill years such as 2025.

To inspect navigation behavior manually (dashboard -> cycle) and save request/response trace metadata:

```bash
HVCS_MANUAL_TO_CYCLE=1 HVCS_ELECTRIC_NUMBER='your-electric-number' npm run open:cycle
```

If `HVCS_ELECTRIC_NUMBER` is blank, the script pauses on the `用電管理` flow and waits for you to click the desired `電號` in the browser. It now detects the context switch automatically and continues on its own; terminal confirmation is only used as a timeout fallback.

Managed skill artifacts are written to:

- `artifacts/hvcs-basic-all/<electric-number>/<selected-year>.json`
- `artifacts/hvcs-power-analyze-day/<electric-number>/<YYYY-MM-DD>.json`
- `artifacts/hvcs-power-analyze-month/<electric-number>/<YYYY-MM>.json`
- `artifacts/hvcs-power-analyze-range/<electric-number>/<YYYY-MM-DD>_to_<YYYY-MM-DD>.json`

Other non-skill debug outputs are still written to:

- `output/today-dashboard.json`
- `output/today-dashboard.cleaned.json`
- `output/cycle-navigation-requests.json` (only when `HVCS_MANUAL_TO_CYCLE=1`)

The script reuses the persistent browser profile in `.auth/browser-profile`, navigates by menu text, and extracts:

- clean dashboard key/value data in `output/today-dashboard.cleaned.json`
- full debug output in `output/today-dashboard.json`

If the session is no longer authenticated, the script opens the real login page, waits for you to complete captcha/login, saves the refreshed session to `.auth/storage-state.json`, and continues in the same browser context.
It now detects successful login automatically; terminal confirmation is only used as a timeout fallback if the page does not transition cleanly.

If the site layout changes and a menu item cannot be found, the script pauses and lets you navigate manually in the browser, then continues extracting from the page you reached.
