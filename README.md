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

To navigate to `需量分析 (PowerAnalyze)`, switch to `每15分鐘`, target yesterday data, and save as `output/power-analyze.*`:

```bash
npm run open:power-analyze
```

To run `用戶資料 + 用電紀錄 + 電費紀錄` in one shot and save:
- `output/basic_all.json`

```bash
npm run basic:all
```

To inspect navigation behavior manually (dashboard -> cycle) and save request/response trace metadata:

```bash
HVCS_MANUAL_TO_CYCLE=1 HVCS_ELECTRIC_NUMBER='your-electric-number' npm run open:cycle
```

If `HVCS_ELECTRIC_NUMBER` is blank, the script pauses on the `用電管理` flow and waits for you to click the desired `電號` in the browser. It now detects the context switch automatically and continues on its own; terminal confirmation is only used as a timeout fallback.

Artifacts are written to:

- `output/today-dashboard.json`
- `output/today-dashboard.cleaned.json`
- `output/today-dashboard.html`
- `output/today-dashboard.png`
- `output/cycle-navigation-requests.json` (only when `HVCS_MANUAL_TO_CYCLE=1`)

The script reuses the persistent browser profile in `.auth/browser-profile`, navigates by menu text, and extracts:

- clean dashboard key/value data in `output/today-dashboard.cleaned.json`
- full debug output in `output/today-dashboard.json`
- raw HTML and screenshot for troubleshooting

If the session is no longer authenticated, the script opens the real login page, waits for you to complete captcha/login, saves the refreshed session to `.auth/storage-state.json`, and continues in the same browser context.
It now detects successful login automatically; terminal confirmation is only used as a timeout fallback if the page does not transition cleanly.

If the site layout changes and a menu item cannot be found, the script pauses and lets you navigate manually in the browser, then continues extracting from the page you reached.
