const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

const ENV_PATH = path.resolve(__dirname, "..", ".env");
const BASE_URL = "https://service.taipower.com.tw/hvcs/";
const LOGIN_PATH_FRAGMENT = "/Account/NewLogon";
const UID_METER_LIST_PATH = "/hvcs/Customer/Module/UIDMeterNoList";
const CYCLE_PATH = "/hvcs/Customer/Module/Cycle";
const AUTH_DIR = path.resolve(__dirname, "..", ".auth");
const USER_DATA_DIR = path.join(AUTH_DIR, "browser-profile");
const STORAGE_STATE_PATH = path.join(AUTH_DIR, "storage-state.json");
const OUTPUT_DIR = path.resolve(__dirname, "..", "output");
const TARGET_PAGE = (process.env.HVCS_TARGET_PAGE || "dashboard").trim().toLowerCase();
const TARGET_BASENAME = TARGET_PAGE === "cycle" ? "cycle-page" : "today-dashboard";
const OUTPUT_PATH = path.join(OUTPUT_DIR, `${TARGET_BASENAME}.json`);
const CLEAN_OUTPUT_PATH = path.join(OUTPUT_DIR, `${TARGET_BASENAME}.cleaned.json`);
const HTML_SNAPSHOT_PATH = path.join(OUTPUT_DIR, `${TARGET_BASENAME}.html`);
const SCREENSHOT_PATH = path.join(OUTPUT_DIR, `${TARGET_BASENAME}.png`);
const LANDING_HTML_PATH = path.join(OUTPUT_DIR, "landing-page.html");
const LANDING_SCREENSHOT_PATH = path.join(OUTPUT_DIR, "landing-page.png");
const LANDING_TEXT_PATH = path.join(OUTPUT_DIR, "landing-page.txt");
const LANDING_META_PATH = path.join(OUTPUT_DIR, "landing-page.json");
const CYCLE_NAV_TRACE_PATH = path.join(OUTPUT_DIR, "cycle-navigation-requests.json");
const CANDIDATE_SUCCESS_TEXT = ["登出", "登    出", "會員專區", "用電資料查詢"];
const DASHBOARD_TEXT = "本日用電儀表板";
const CYCLE_TEXT = "不同期間電費比較";
const USER_INFO_TEXT = "用戶資訊";
const AUTH_TIMEOUT_MS = Number(process.env.HVCS_AUTH_TIMEOUT_MS || 180000);
const ELECTRIC_SELECTION_TIMEOUT_MS = Number(process.env.HVCS_ELECTRIC_SELECTION_TIMEOUT_MS || 120000);
const DASHBOARD_LOAD_TIMEOUT_MS = Number(process.env.HVCS_DASHBOARD_TIMEOUT_MS || 120000);
const MANUAL_CYCLE_MONITOR = /^(1|true|yes)$/i.test((process.env.HVCS_MANUAL_TO_CYCLE || "").trim());
const DOMCONTENTLOADED_TIMEOUT_MS = Number(process.env.HVCS_DOMCONTENTLOADED_TIMEOUT_MS || 10000);
const NETWORKIDLE_TIMEOUT_MS = Number(process.env.HVCS_NETWORKIDLE_TIMEOUT_MS || 5000);
const ACCOUNT_SELECTOR =
  'input[placeholder*="帳號"], input[placeholder*="使用者"], input[name*="Account"], input[id*="Account"], input[name*="User"], input[id*="User"], input[autocomplete="username"], input[autocomplete="email"]';
const PASSWORD_SELECTOR =
  'input[placeholder*="密碼"], input[name*="Password"], input[id*="Password"], input[type="password"]';
const CAPTCHA_SELECTOR =
  'input[placeholder*="驗證碼"], input[name*="Captcha"], input[id*="Captcha"], input[name*="Verify"], input[id*="Verify"], input[name*="Code"], input[id*="Code"]';

loadEnvFile();

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function waitForEnter(prompt) {
  const answer = await askQuestion(prompt);
  return answer;
}

async function askQuestion(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    return;
  }

  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

async function waitForPageSettled(page, extraWaitMs = 900) {
  await page
    .waitForLoadState("domcontentloaded", { timeout: DOMCONTENTLOADED_TIMEOUT_MS })
    .catch(() => {});
  await page
    .waitForLoadState("networkidle", { timeout: NETWORKIDLE_TIMEOUT_MS })
    .catch(() => {});
  if (extraWaitMs > 0) {
    await page.waitForTimeout(extraWaitMs);
  }
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function ensureVisibleAndClick(locator, label) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      log(`Clicked: ${label}`);
      return true;
    }
  }

  throw new Error(`Visible element not found for ${label}.`);
}

async function clickByText(page, text) {
  const candidates = [
    page.getByRole("link", { name: text, exact: true }),
    page.getByRole("button", { name: text, exact: true }),
    page.getByText(text, { exact: true }),
    page.locator(`text=${text}`),
  ];

  for (const locator of candidates) {
    if ((await locator.count().catch(() => 0)) > 0) {
      if (await ensureVisibleAndClick(locator, text).catch(() => false)) {
        return true;
      }
    }
  }

  return false;
}

async function openCycleFromUserInfo(page) {
  const userInfoClicked = await clickByText(page, USER_INFO_TEXT);
  if (userInfoClicked) {
    await waitForPageSettled(page, 700);
  }

  return clickByText(page, CYCLE_TEXT);
}

async function pageHasVisibleText(page, text) {
  const candidates = [
    page.getByRole("link", { name: text, exact: true }),
    page.getByRole("button", { name: text, exact: true }),
    page.getByText(text, { exact: true }),
    page.locator(`text=${text}`),
  ];

  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return true;
      }
    }
  }

  return false;
}

async function pageLooksLikeDashboard(page) {
  const title = normalizeText(await page.title().catch(() => ""));
  if (title.includes(DASHBOARD_TEXT)) {
    return true;
  }

  if (await pageHasVisibleText(page, DASHBOARD_TEXT)) {
    return true;
  }

  const dashboardSignals = [
    page.locator("#forwardBasic").first(),
    page.locator("#fifteenMinuteChart").first(),
    page.locator("#UnionChart").first(),
  ];

  for (const locator of dashboardSignals) {
    if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) {
      return true;
    }
  }

  return false;
}

async function pageLooksLikeCycle(page) {
  const title = normalizeText(await page.title().catch(() => ""));
  if (title.includes(CYCLE_TEXT) || page.url().includes(CYCLE_PATH)) {
    return true;
  }

  // Avoid false positives from sidebar/menu links that exist on non-cycle pages.
  const cycleContentSignals = [
    page.getByText("請選擇年份", { exact: false }).first(),
    page.getByText("固定區間", { exact: false }).first(),
    page.getByText("自訂區間", { exact: false }).first(),
    page.getByText("請選擇時段", { exact: false }).first(),
  ];

  for (const locator of cycleContentSignals) {
    if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) {
      return true;
    }
  }

  return false;
}

async function pageLooksLikeTarget(page) {
  if (TARGET_PAGE === "cycle") {
    return pageLooksLikeCycle(page);
  }

  return pageLooksLikeDashboard(page);
}

async function promptForManualNavigation(page, targetDescription) {
  const startUrl = page.url();
  const startText = await page.locator("body").innerText().catch(() => "");

  log(`Could not navigate automatically to ${targetDescription}.`);
  log(`Navigate there manually in the browser, then press Enter here.`);
  await waitForEnter("> ");
  await waitForPageSettled(page);

  const currentUrl = page.url();
  const currentText = await page.locator("body").innerText().catch(() => "");

  if (currentUrl === startUrl && normalizeText(currentText) === normalizeText(startText)) {
    log("No page change was detected. If the page updated without a full navigation, press Enter once more after it finishes rendering.");
    await waitForEnter("> ");
    await waitForPageSettled(page);
  }
}

async function waitForAuthenticated(page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await waitForPageSettled(page);

  if (await pageLooksUnauthenticated(page)) {
    return false;
  }

  return true;
}

async function pageLooksUnauthenticated(page) {
  const currentUrl = page.url();
  if (currentUrl.includes(LOGIN_PATH_FRAGMENT)) {
    return true;
  }

  const loginSignals = [
    page.locator('input[type="password"]').first(),
    page.locator('input[placeholder*="帳號"], input[name*="Account"], input[id*="Account"]').first(),
    page.getByText("驗證碼", { exact: false }).first(),
    page.getByText("登入", { exact: false }).first(),
  ];

  for (const locator of loginSignals) {
    if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) {
      return true;
    }
  }

  return false;
}

async function pageLooksAuthenticated(page) {
  if (!(await pageLooksUnauthenticated(page))) {
    return true;
  }

  for (const text of CANDIDATE_SUCCESS_TEXT) {
    const match = page.getByText(text, { exact: false }).first();
    if ((await match.count()) > 0 && (await match.isVisible().catch(() => false))) {
      return true;
    }
  }

  return false;
}

async function fillIfVisible(page, selector, value) {
  if (!value) return false;

  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  if (count === 0) return false;

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    await candidate.fill(value);
    return true;
  }

  return false;
}

async function focusIfVisible(page, selector) {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  if (count === 0) return false;

  await page.bringToFront().catch(() => {});

  const activeLooksCaptcha = async () =>
    page
      .evaluate(() => {
        const el = document.activeElement;
        if (!el || el.tagName !== "INPUT") return false;
        const attrs = [
          el.getAttribute("name") || "",
          el.getAttribute("id") || "",
          el.getAttribute("placeholder") || "",
        ]
          .join(" ")
          .toLowerCase();
        return /驗證碼|captcha|verify|code/.test(attrs);
      })
      .catch(() => false);

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    await candidate.click({ force: true }).catch(() => {});
    await candidate.focus().catch(() => {});
    await page.waitForTimeout(80);
    if (await activeLooksCaptcha()) {
      return true;
    }
  }

  return false;
}

async function getActivePage(context, fallbackPage) {
  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  const page = pages[pages.length - 1] || fallbackPage;

  if (!page) {
    throw new Error("No browser page is available.");
  }

  await waitForPageSettled(page, 250);
  return page;
}

async function saveState(context, page) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await waitForPageSettled(page);
  await context.storageState({ path: STORAGE_STATE_PATH });
}

async function saveLandingSnapshot(page, reason) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const text = await page.locator("body").innerText().catch(() => "");
  const payload = {
    capturedAt: new Date().toISOString(),
    reason,
    url: page.url(),
    title: await page.title().catch(() => ""),
  };

  fs.writeFileSync(LANDING_HTML_PATH, await page.content(), "utf8");
  fs.writeFileSync(LANDING_TEXT_PATH, text, "utf8");
  fs.writeFileSync(LANDING_META_PATH, JSON.stringify(payload, null, 2));
  await page.screenshot({ path: LANDING_SCREENSHOT_PATH, fullPage: true });

  log(`Saved landing HTML: ${LANDING_HTML_PATH}`);
  log(`Saved landing text: ${LANDING_TEXT_PATH}`);
  log(`Saved landing screenshot: ${LANDING_SCREENSHOT_PATH}`);
  log(`Saved landing metadata: ${LANDING_META_PATH}`);
}

async function waitForAuthenticationTransition(context, initialPage, timeoutMs = AUTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let page = initialPage;

  while (Date.now() < deadline) {
    page = await getActivePage(context, page);

    if (await pageLooksAuthenticated(page)) {
      await waitForPageSettled(page);
      return page;
    }

    await page.waitForTimeout(1000);
  }

  return null;
}

async function waitForElectricNumberTransition(context, initialPage, startUrl, startText, timeoutMs = ELECTRIC_SELECTION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let page = initialPage;

  while (Date.now() < deadline) {
    page = await getActivePage(context, page);
    await waitForPageSettled(page, 150);

    const currentUrl = page.url();
    const currentText = await page.locator("body").innerText().catch(() => "");

    if (currentUrl !== startUrl) {
      return page;
    }

    if (normalizeText(currentText) !== normalizeText(startText)) {
      return page;
    }

    if (await pageHasVisibleText(page, DASHBOARD_TEXT)) {
      return page;
    }

    await page.waitForTimeout(1000);
  }

  return null;
}

async function waitForTargetTransition(context, initialPage, startUrl, startText, timeoutMs = DASHBOARD_LOAD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let page = initialPage;

  while (Date.now() < deadline) {
    page = await getActivePage(context, page);
    await waitForPageSettled(page, 150);

    if (await pageLooksLikeTarget(page)) {
      return page;
    }

    const currentUrl = page.url();
    const currentText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    if (currentUrl !== startUrl || currentText !== normalizeText(startText)) {
      const settledPage = await getActivePage(context, page);
      if (await pageLooksLikeTarget(settledPage)) {
        return settledPage;
      }
    }

    await page.waitForTimeout(1000);
  }

  return null;
}

async function ensureAuthenticated(context, page) {
  if (await waitForAuthenticated(page)) {
    return page;
  }

  log("Saved session is not authenticated.");
  log("A browser window will stay open so you can complete the HVCS login and captcha.");

  const accountFilled = await fillIfVisible(
    page,
    ACCOUNT_SELECTOR,
    process.env.HVCS_ACCOUNT
  );

  const passwordFilled = await fillIfVisible(
    page,
    PASSWORD_SELECTOR,
    process.env.HVCS_PASSWORD
  );

  if (accountFilled || passwordFilled) {
    log("Filled credentials from environment variables where possible.");
  }

  if (await focusIfVisible(page, CAPTCHA_SELECTOR)) {
    log("Focused captcha input. Enter captcha in the browser to continue.");
  }

  log("Complete the remaining login steps in the browser.");
  log("The script will continue automatically after login succeeds.");

  const authenticatedPage = await waitForAuthenticationTransition(context, page);
  if (authenticatedPage) {
    page = authenticatedPage;
  } else {
    log(`Authentication was not detected automatically within ${Math.round(AUTH_TIMEOUT_MS / 60000)} minutes.`);
    log("If the login finished and the page is ready, press Enter to check again.");
    await waitForEnter("> ");
    page = await getActivePage(context, page);
  }

  if (!(await pageLooksAuthenticated(page))) {
    throw new Error("Still on the login page. Login did not complete, so extraction was not started.");
  }

  await saveState(context, page);
  log(`Updated saved session at ${STORAGE_STATE_PATH}`);
  await saveLandingSnapshot(page, "post-login");
  return page;
}

async function chooseElectricNumber(context, page) {
  const configuredElectricNumber = (process.env.HVCS_ELECTRIC_NUMBER || "").trim();

  if (!configuredElectricNumber) {
    const selection = await waitForManualElectricNumberSelection(context, page);
    const selected = selection.selected;
    process.env.HVCS_ELECTRIC_NUMBER = selected || "";
    return selection.page;
  }

  const startUrl = page.url();
  const startText = await page.locator("body").innerText().catch(() => "");

  if (await clickElectricNumber(page, configuredElectricNumber)) {
    const updatedPage = await waitForElectricNumberTransition(
      context,
      page,
      startUrl,
      startText,
      ELECTRIC_SELECTION_TIMEOUT_MS
    );
    return updatedPage || page;
  }

  throw new Error(`Could not find configured 電號: ${configuredElectricNumber}`);
}

async function clickElectricNumber(page, electricNumber) {
  const row = page
    .locator("tr")
    .filter({ has: page.locator(`td[data-th="電號"]`, { hasText: electricNumber }) })
    .first();

  if ((await row.count().catch(() => 0)) > 0 && (await row.isVisible().catch(() => false))) {
    const reviewButton = row.locator('input[type="submit"][value="檢視"], button:has-text("檢視")').first();
    if ((await reviewButton.count().catch(() => 0)) > 0) {
      await ensureVisibleAndClick(reviewButton, `電號 ${electricNumber} -> 檢視`);
      return true;
    }

    const fallbackTarget = row.getByText(electricNumber, { exact: true }).first();
    if ((await fallbackTarget.count().catch(() => 0)) > 0) {
      await ensureVisibleAndClick(fallbackTarget, `電號 ${electricNumber}`);
      return true;
    }
  }

  return false;
}

async function waitForManualElectricNumberSelection(context, page) {
  const startUrl = page.url();
  const startText = await page.locator("body").innerText().catch(() => "");

  log("HVCS_ELECTRIC_NUMBER is blank.");
  log("Select the desired 電號 in the browser.");
  log("The script will continue automatically after the site switches context.");

  const updatedPage = await waitForElectricNumberTransition(context, page, startUrl, startText);
  if (updatedPage) {
    page = updatedPage;
  } else {
    log(`No page change was detected automatically within ${Math.round(ELECTRIC_SELECTION_TIMEOUT_MS / 60000)} minutes.`);
    log("If the selection finished and the page is ready, press Enter to check again.");
    await waitForEnter("> ");
    page = await getActivePage(context, page);
    await waitForPageSettled(page);
  }

  const selected = await detectSelectedElectricNumber(page);
  if (selected) {
    log(`Detected 電號 context: ${selected}`);
  }

  return { page, selected };
}

async function detectSelectedElectricNumber(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  const matches = [...new Set(text.match(/\b\d{8,14}\b/g) || [])];
  if (matches.length === 1) {
    return matches[0];
  }

  const activeCandidates = await page.$$eval(
    "a, button, td, th, div, span, option, input",
    (nodes) => {
      const results = [];
      for (const node of nodes) {
        const raw =
          node.tagName === "INPUT"
            ? node.getAttribute("value") || ""
            : node.textContent || "";
        const text = raw.replace(/\s+/g, " ").trim();
        if (!/^\d{8,14}$/.test(text)) continue;
        if (
          node.classList.contains("active") ||
          node.getAttribute("aria-current") ||
          node.getAttribute("selected") !== null
        ) {
          results.push(text);
        }
      }
      return results;
    }
  );

  return activeCandidates[0] || "";
}

async function navigateToTarget(context, page) {
  await page.goto(`https://service.taipower.com.tw${UID_METER_LIST_PATH}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForPageSettled(page);
  log(`Opened: ${UID_METER_LIST_PATH}`);

  await saveLandingSnapshot(page, "after-用電管理");

  page = await chooseElectricNumber(context, page);

  if (TARGET_PAGE !== "cycle" && (await pageLooksLikeTarget(page))) {
    return page;
  }

  if (TARGET_PAGE === "cycle") {
    if (MANUAL_CYCLE_MONITOR) {
      log("Manual cycle monitor mode is ON.");
      log("After dashboard loads, navigate to `不同期間電費比較` manually in the browser.");
      log("The script is monitoring requests and will continue when cycle page is detected.");

      const monitor = createCycleNavigationMonitor(context);
      const startUrl = page.url();
      const startText = await page.locator("body").innerText().catch(() => "");
      const cyclePage = await waitForTargetTransition(context, page, startUrl, startText, AUTH_TIMEOUT_MS);

      let finalPage = cyclePage;
      if (!finalPage) {
        log("Cycle page was not detected automatically in time.");
        log("If it is open now, press Enter to continue.");
        await waitForEnter("> ");
        finalPage = await getActivePage(context, page);
        await waitForPageSettled(finalPage);
      }

      monitor.stopAndSave();
      return finalPage || page;
    }

    const startUrl = page.url();
    const startText = await page.locator("body").innerText().catch(() => "");

    await page.goto(`https://service.taipower.com.tw${CYCLE_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForPageSettled(page);

    const cyclePage = await waitForTargetTransition(context, page, startUrl, startText);
    if (cyclePage) {
      return cyclePage;
    }

    // Fallback path if direct navigation is blocked or the route changes.
    if (await openCycleFromUserInfo(page)) {
      const clickedCyclePage = await waitForTargetTransition(context, page, startUrl, startText);
      if (clickedCyclePage) {
        return clickedCyclePage;
      }
      page = clickedCyclePage || page;
    } else {
      await promptForManualNavigation(page, `\`${CYCLE_TEXT}\``);
    }

    return page;
  }

  const startUrl = page.url();
  const startText = await page.locator("body").innerText().catch(() => "");

  if (!(await clickByText(page, DASHBOARD_TEXT))) {
    await promptForManualNavigation(page, "`本日用電儀表板`");
  } else {
    const dashboardPage = await waitForTargetTransition(context, page, startUrl, startText);
    page = dashboardPage || page;
  }

  return page;
}

async function collectTables(page) {
  return page.$$eval("table", (tables) =>
    tables
      .map((table, index) => {
        const headers = Array.from(table.querySelectorAll("th")).map((cell) =>
          (cell.textContent || "").replace(/\s+/g, " ").trim()
        );
        const rows = Array.from(table.querySelectorAll("tr"))
          .map((row) =>
            Array.from(row.querySelectorAll("th, td")).map((cell) =>
              (cell.textContent || "").replace(/\s+/g, " ").trim()
            )
          )
          .filter((row) => row.some(Boolean));

        if (!rows.length) {
          return null;
        }

        return {
          index,
          headers,
          rows,
        };
      })
      .filter(Boolean)
  );
}

async function collectDefinitionLists(page) {
  return page.$$eval("dl", (lists) =>
    lists
      .map((list) => {
        const keys = Array.from(list.querySelectorAll("dt"));
        const values = Array.from(list.querySelectorAll("dd"));
        const pairs = keys
          .map((key, index) => {
            const label = (key.textContent || "").replace(/\s+/g, " ").trim();
            const value = (values[index]?.textContent || "").replace(/\s+/g, " ").trim();
            return label && value ? { label, value } : null;
          })
          .filter(Boolean);
        return pairs.length ? pairs : null;
      })
      .filter(Boolean)
      .flat()
  );
}

async function collectMetricCandidates(page) {
  return page.$$eval("body *", (nodes) => {
    const items = [];
    for (const node of nodes) {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (text.length > 80) continue;
      if (!/[0-9]/.test(text)) continue;

      const labelSource =
        node.getAttribute("aria-label") ||
        node.previousElementSibling?.textContent ||
        node.parentElement?.querySelector("label, h1, h2, h3, h4, h5, h6, .title, .label")?.textContent ||
        "";

      const label = (labelSource || "").replace(/\s+/g, " ").trim();
      items.push({
        label,
        value: text,
      });
    }

    return items;
  });
}

function dedupeMetrics(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.label}::${item.value}`;
    if (!item.value || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function collectHeadings(page) {
  return page.$$eval("h1, h2, h3, h4", (nodes) =>
    nodes
      .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );
}

async function collectVisibleText(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  return normalizeText(text);
}

async function collectCycleRawChartData(page) {
  return page
    .evaluate(() => {
      const charts = (window.Highcharts && Array.isArray(window.Highcharts.charts)
        ? window.Highcharts.charts
        : []
      )
        .filter(Boolean)
        .map((chart) => {
          const title = chart.title?.textStr || "";
          const renderTo = chart.renderTo?.id || null;
          const xAxisCategories =
            chart.xAxis?.[0]?.categories?.slice?.() ||
            chart.xAxis?.[0]?.tickPositions?.slice?.() ||
            [];

          const yAxes = (chart.yAxis || []).map((axis) => ({
            title: axis.axisTitle?.textStr || axis.options?.title?.text || "",
            min: axis.min ?? null,
            max: axis.max ?? null,
          }));

          const series = (chart.series || []).map((seriesItem) => ({
            name: seriesItem.name || "",
            type: seriesItem.type || "",
            stack: seriesItem.options?.stack ?? null,
            color: seriesItem.color || seriesItem.options?.color || null,
            visible: seriesItem.visible !== false,
            data: (seriesItem.options?.data || []).map((point) => {
              if (typeof point === "number" || point === null) {
                return point;
              }
              if (Array.isArray(point)) {
                return { x: point[0] ?? null, y: point[1] ?? null };
              }
              if (point && typeof point === "object") {
                return {
                  x: point.x ?? null,
                  y: point.y ?? null,
                };
              }
              return point;
            }),
          }));

          return {
            title,
            renderTo,
            xAxisCategories,
            yAxes,
            series,
          };
        });

      return charts;
    })
    .catch(() => []);
}

function normalizeChartValues(data) {
  if (!Array.isArray(data)) return [];
  return data.map((point) => {
    if (typeof point === "number") return point;
    if (point === null) return null;
    if (Array.isArray(point)) return toNumber(point[1]);
    if (typeof point === "object") return toNumber(point.y);
    return toNumber(point);
  });
}

function pickLatestCycleCharts(rawCharts) {
  const usageMatch = [];
  const billingMatch = [];

  for (const chart of rawCharts || []) {
    const title = normalizeText(chart?.title || "");
    const renderTo = normalizeText(chart?.renderTo || "");

    if (title.includes("用電量比較") || renderTo === "container") {
      usageMatch.push(chart);
    }
    if (title.includes("電費比較") || renderTo === "billingcompare") {
      billingMatch.push(chart);
    }
  }

  return {
    usage: usageMatch[usageMatch.length - 1] || null,
    billing: billingMatch[billingMatch.length - 1] || null,
  };
}

function trimLeadingZeroCategory(categories, seriesValues) {
  if (!Array.isArray(categories) || categories.length === 0) return categories || [];
  const first = String(categories[0] || "");
  const shouldTrimFirst = /^(0|0月)$/i.test(first);
  if (!shouldTrimFirst) return categories;

  const maxSeriesLen = Math.max(0, ...seriesValues.map((values) => values.length));
  if (maxSeriesLen === categories.length - 1) {
    return categories.slice(1);
  }
  return categories;
}

function monthIndexFromCategory(category, fallbackIndex) {
  const text = String(category || "").trim();
  const match = text.match(/(\d{1,2})/);
  if (match) {
    const month = Number(match[1]);
    if (month >= 1 && month <= 12) {
      return month - 1;
    }
  }
  if (fallbackIndex >= 0 && fallbackIndex < 12) {
    return fallbackIndex;
  }
  return -1;
}

function buildNormalizedChart(chart, chartKey, valueUnit) {
  if (!chart) return null;

  const rawSeries = Array.isArray(chart.series) ? chart.series : [];
  const series = rawSeries
    .map((item) => {
      const values = normalizeChartValues(item.data || []);
      return {
        name: normalizeText(item.name || ""),
        period: normalizeText(String(item.stack || "")) || null,
        values,
      };
    })
    .filter((item) => item.name && item.values.length > 0);

  const seriesValues = series.map((item) => item.values);
  let categories = Array.isArray(chart.xAxisCategories) ? chart.xAxisCategories.map((x) => String(x)) : [];
  categories = trimLeadingZeroCategory(categories, seriesValues);

  // Align lengths to categories for direct downstream usage.
  const alignedSeries = series.map((item) => {
    const alignedValues = categories.map((_, idx) => item.values[idx] ?? null);
    const points = categories
      .map((category, idx) => ({
        category,
        category_index: idx,
        value: alignedValues[idx],
      }))
      .filter((point) => point.value !== null);

    return {
      name: item.name,
      period: item.period,
      points,
    };
  });

  const metricByYear = {};
  for (const seriesItem of alignedSeries) {
    const metric = seriesItem.name;
    const year = seriesItem.period || "unknown";
    if (!metricByYear[metric]) {
      metricByYear[metric] = {};
    }
    if (!metricByYear[metric][year]) {
      metricByYear[metric][year] = Array(12).fill(null);
    }

    for (const point of seriesItem.points) {
      const idx = monthIndexFromCategory(point.category, point.category_index);
      if (idx === -1) continue;
      metricByYear[metric][year][idx] = point.value;
    }
  }

  return {
    key: chartKey,
    title: chart.title || "",
    unit: valueUnit,
    categories,
    series: alignedSeries,
    metric_by_year: metricByYear,
  };
}

function buildCycleDataModel(rawCharts) {
  const picked = pickLatestCycleCharts(rawCharts || []);
  const usage = buildNormalizedChart(picked.usage, "usage", "kWh");
  const billing = buildNormalizedChart(picked.billing, "billing", "TWD");

  return {
    schema_version: 1,
    charts: [usage, billing].filter(Boolean),
  };
}

function parseJsArrayFromHtml(html, variableName) {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`var\\s+${escaped}\\s*=\\s*(\\[[\\s\\S]*?\\]);`));
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/'/g, '"'));
  } catch {
    return null;
  }
}

function parseOnPointFromHtml(html) {
  const block = html.match(/var\s+ONPoint\s*=\s*(\[[\s\S]*?\]);/);
  if (!block) return [];

  const jsonLike = block[1]
    .replace(/(\w+)\s*:/g, '"$1":')
    .replace(/'/g, '"')
    .replace(/,\s*([}\]])/g, "$1");

  try {
    const parsed = JSON.parse(jsonLike);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseCycleRawChartDataFromHtml(html) {
  const x1 = parseJsArrayFromHtml(html, "highchart_x1") || [];
  const x2 = parseJsArrayFromHtml(html, "highchart_x2") || [];
  const onPoint = parseOnPointFromHtml(html);

  const years = [1, 2, 3, 4, 5]
    .map((idx) => {
      const match = html.match(new RegExp(`seriesName${idx}\\s*=\\s*'([^']*)'`));
      return match?.[1] || "";
    })
    .filter(Boolean);

  const buildBillSeries = (suffix, label) =>
    years.map((year, idx) => {
      const n = idx + 1;
      const data = parseJsArrayFromHtml(html, `highchart_BillY${n}_${suffix}`) || [];
      return {
        name: label,
        stack: year,
        data,
      };
    });

  return [
    {
      title: "用電量比較",
      renderTo: "container",
      xAxisCategories: x1,
      series: onPoint.map((item) => ({
        name: item.name || "",
        stack: item.stack ?? null,
        color: item.color || null,
        data: Array.isArray(item.data) ? item.data : [],
      })),
    },
    {
      title: "電費比較",
      renderTo: "billingCompare",
      xAxisCategories: x2,
      series: [
        ...buildBillSeries("EX", "流動電費"),
        ...buildBillSeries("NM", "基本電費(約定)"),
        ...buildBillSeries("OVER", "基本電費(非約定)"),
      ],
    },
  ];
}

function createCycleNavigationMonitor(context) {
  const events = [];
  const startedAt = Date.now();

  const requestHandler = (request) => {
    const url = request.url();
    if (!url.includes("/hvcs/")) return;

    events.push({
      atMs: Date.now() - startedAt,
      type: "request",
      method: request.method(),
      url,
      resourceType: request.resourceType(),
      headers: {
        referer: request.headers().referer || null,
        origin: request.headers().origin || null,
      },
    });
  };

  const responseHandler = (response) => {
    const url = response.url();
    if (!url.includes("/hvcs/")) return;

    events.push({
      atMs: Date.now() - startedAt,
      type: "response",
      url,
      status: response.status(),
      ok: response.ok(),
    });
  };

  context.on("request", requestHandler);
  context.on("response", responseHandler);

  return {
    stopAndSave() {
      context.off("request", requestHandler);
      context.off("response", responseHandler);
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(
        CYCLE_NAV_TRACE_PATH,
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            manualMode: true,
            totalEvents: events.length,
            events,
          },
          null,
          2
        )
      );
      log(`Saved cycle navigation request trace: ${CYCLE_NAV_TRACE_PATH}`);
    },
  };
}

function buildKeyValueObject(pairs) {
  const result = {};
  for (const { label, value } of pairs) {
    const key = slugify(label || value);
    if (!key) continue;
    if (!(key in result)) {
      result[key] = value;
      continue;
    }

    if (!Array.isArray(result[key])) {
      result[key] = [result[key]];
    }
    result[key].push(value);
  }
  return result;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned || cleaned === "null") return null;
  const numericMatch = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!numericMatch) return null;
  const parsed = Number(numericMatch[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractChartBlock(html, chartId) {
  const escapedId = chartId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`Highcharts\\.chart\\('${escapedId}'[\\s\\S]*?<\\/script>`));
  return match?.[0] || "";
}

function parseJsArrayLiteral(html, variableName) {
  const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`var\\s+${escapedName}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) return null;

  const raw = `[${match[1]}]`
    .replace(/\bnull\b/g, "null")
    .replace(/,\s*,/g, ", null,")
    .replace(/\[\s*,/g, "[null,")
    .replace(/,\s*]/g, ", null]");

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseJsScalar(html, variableName) {
  const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`(?:var|let)\\s+${escapedName}\\s*=\\s*([^;]+);`));
  if (!match) return null;

  const value = match[1].trim();
  if (/^['"].*['"]$/.test(value)) {
    return value.slice(1, -1);
  }

  if (value === "null") return null;
  return toNumber(value);
}

function parseCategories(html) {
  const block = extractChartBlock(html, "fifteenMinuteChart");
  const match = block.match(/categories:\s*\[([\s\S]*?)\]\s*\n\s*\}/);
  if (!match) return [];

  return match[1]
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseRecentUsage(html) {
  const block = extractChartBlock(html, "UnionChart");
  const categoriesMatch = block.match(/categories:\s*\[([0-9,\s]+)\]/);
  const months = categoriesMatch
    ? categoriesMatch[1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  const seriesPattern = /type:\s*'(column|spline)'[\s\S]*?name:\s*'([^']+)'[\s\S]*?data:\s*\[([^\]]*)\]/g;
  const series = [];
  for (const match of block.matchAll(seriesPattern)) {
    const [, type, name, dataRaw] = match;
    const data = dataRaw
      .split(",")
      .map((item) => toNumber(item))
      .filter((item) => item !== null);
    series.push({ type, name, data });
  }

  return { months, series };
}

function zipSeries(categories, values) {
  if (!Array.isArray(categories) || !Array.isArray(values)) return [];
  return categories.map((category, index) => ({
    category,
    value: values[index] ?? null,
  }));
}

function extractDashboardDataFromHtml(html) {
  const account =
    html.match(/帳號[\s\S]{0,200}?<strong[^>]*class="text-danger"[^>]*>(\d+)<\/strong>/)?.[1] || null;
  const electricNumber =
    html.match(/電號[\s\S]{0,200}?<strong[^>]*class="text-danger"[^>]*>(\d+)<\/strong>/)?.[1] || null;
  const companyName = html.match(/id="forwardBasic"[^>]*value="([^"]+)"/)?.[1] || null;
  const peakCards = [...html.matchAll(/<span class="DH_Time">([^<]+)<\/span>\s*<span class="DH_kW">([^<]+)<\/span>\s*<span class="DH_Title">([^<]+)<\/span>/g)];
  const dayPeakTime = peakCards.find((match) => match[3] === "當日最高需量時間");
  const monthPeakTime = peakCards.find((match) => match[3] === "當月最高需量時間");

  const fifteenMinuteCategories = parseCategories(html);
  const fifteenMinuteSeries = {
    經常契約: parseJsArrayLiteral(html, "經常"),
    尖峰: parseJsArrayLiteral(html, "尖峰"),
    半尖峰: parseJsArrayLiteral(html, "半尖峰"),
    週六半尖峰: parseJsArrayLiteral(html, "週六半尖峰"),
    離峰: parseJsArrayLiteral(html, "離峰"),
  };

  const gauges = {
    尖峰: { value: parseJsScalar(html, "ON"), capacity: parseJsScalar(html, "ONCap") },
    半尖峰: { value: parseJsScalar(html, "HF"), capacity: parseJsScalar(html, "HFCap") },
    週六半尖峰: { value: parseJsScalar(html, "SH"), capacity: parseJsScalar(html, "SHCap") },
    離峰: { value: parseJsScalar(html, "OFF"), capacity: parseJsScalar(html, "OFFCap") },
  };

  const cumulativeUsage = {
    total_kwh: parseJsScalar(html, "DemSum"),
    peak_kwh: parseJsScalar(html, "DemON"),
    half_peak_kwh: parseJsScalar(html, "DemHF"),
    saturday_half_peak_kwh: parseJsScalar(html, "DemSH"),
    off_peak_kwh: parseJsScalar(html, "DemOFF"),
  };

  const recentUsage = parseRecentUsage(html);

  return {
    account,
    electric_number: electricNumber,
    company_name: companyName,
    dashboard_title: html.match(/<span class="fs-1 fw-bold">([^<]+)<\/span>/)?.[1] || null,
    highest_demand_today: dayPeakTime
      ? {
          timestamp: dayPeakTime[1],
          value_kw: toNumber(dayPeakTime[2]),
        }
      : null,
    highest_demand_month: monthPeakTime?.[1]
      ? {
          timestamp: monthPeakTime[1],
          value_kw: toNumber(monthPeakTime[2]),
        }
      : null,
    current_period_max_demand_kw: gauges,
    cumulative_usage_today_kwh: cumulativeUsage,
    fifteen_minute_demand_categories: fifteenMinuteCategories,
    fifteen_minute_demand_series: fifteenMinuteSeries,
    fifteen_minute_demand_points: Object.fromEntries(
      Object.entries(fifteenMinuteSeries).map(([name, values]) => [name, zipSeries(fifteenMinuteCategories, values)])
    ),
    recent_usage_and_bill: recentUsage,
  };
}

async function writeArtifacts(page, payload) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  if (payload.dashboardData) {
    fs.writeFileSync(CLEAN_OUTPUT_PATH, JSON.stringify(payload.dashboardData, null, 2));
  }
  fs.writeFileSync(HTML_SNAPSHOT_PATH, await page.content(), "utf8");
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
}

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 960 },
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    const authenticatedPage = await ensureAuthenticated(context, page);
    const targetPage = await navigateToTarget(context, authenticatedPage);

    if (TARGET_PAGE === "cycle") {
      if (!(await pageLooksLikeCycle(targetPage))) {
        throw new Error(
          `Target page mismatch: expected cycle page but current URL is ${targetPage.url()}`
        );
      }

      log(`Landed on target page: ${targetPage.url()}`);
      log("Select the checkboxes/options you want in the browser.");
      log('When ready, return to terminal and press Enter to continue extraction.');
      await waitForEnter("> ");
      await waitForPageSettled(targetPage);

      const html = await targetPage.content();
      const liveChartData = await collectCycleRawChartData(targetPage);
      const htmlChartData = parseCycleRawChartDataFromHtml(html);
      const chartData = liveChartData.length ? liveChartData : htmlChartData;
      const cycleData = buildCycleDataModel(chartData);

      const payload = {
        extractedAt: new Date().toISOString(),
        source: {
          baseUrl: BASE_URL,
          pageUrl: targetPage.url(),
          electricNumber: (process.env.HVCS_ELECTRIC_NUMBER || "").trim() || null,
        },
        targetPage: TARGET_PAGE,
        title: await targetPage.title().catch(() => ""),
        text: await collectVisibleText(targetPage),
        chartDataSource: liveChartData.length ? "window.Highcharts.charts" : "rendered-html-script",
        cycleData,
      };

      await writeArtifacts(targetPage, payload);

      log(`Saved JSON: ${OUTPUT_PATH}`);
      log(`Saved HTML snapshot: ${HTML_SNAPSHOT_PATH}`);
      log(`Saved screenshot: ${SCREENSHOT_PATH}`);
      return;
    }

    const headings = await collectHeadings(targetPage);
    const definitionListPairs = await collectDefinitionLists(targetPage);
    const metricCandidates = dedupeMetrics(await collectMetricCandidates(targetPage));
    const tables = await collectTables(targetPage);
    const visibleText = await collectVisibleText(targetPage);
    const html = await targetPage.content();
    const dashboardData = extractDashboardDataFromHtml(html);

    const payload = {
      extractedAt: new Date().toISOString(),
      source: {
        baseUrl: BASE_URL,
        pageUrl: targetPage.url(),
        electricNumber:
          dashboardData.electric_number || (process.env.HVCS_ELECTRIC_NUMBER || "").trim() || null,
      },
      dashboardData,
      headings,
      keyValues: buildKeyValueObject(definitionListPairs),
      definitionListPairs,
      metrics: metricCandidates,
      tables,
      text: visibleText,
    };

    await writeArtifacts(targetPage, payload);

    log(`Saved JSON: ${OUTPUT_PATH}`);
    log(`Saved cleaned JSON: ${CLEAN_OUTPUT_PATH}`);
    log(`Saved HTML snapshot: ${HTML_SNAPSHOT_PATH}`);
    log(`Saved screenshot: ${SCREENSHOT_PATH}`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
