const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const ENV_PATH = path.resolve(__dirname, "..", ".env");
const BASE_URL = "https://service.taipower.com.tw/hvcs/";
const LOGIN_PATH_FRAGMENT = "/Account/NewLogon";
const UID_METER_LIST_PATH = "/hvcs/Customer/Module/UIDMeterNoList";
const CYCLE_PATH = "/hvcs/Customer/Module/Cycle";
const BASIC_PATH = "/hvcs/Customer/Module/Basic";
const POWER_ANALYZE_PATH = "/hvcs/Customer/Module/PowerAnalyze";
const AUTH_DIR = path.resolve(__dirname, "..", ".auth");
const STORAGE_STATE_PATH = path.join(AUTH_DIR, "storage-state.json");
const OUTPUT_DIR = path.resolve(__dirname, "..", "output");
const ARTIFACTS_DIR = path.resolve(__dirname, "..", "artifacts");
const TARGET_PAGE = (process.env.HVCS_TARGET_PAGE || "dashboard").trim().toLowerCase();
const TARGET_BASENAME =
  TARGET_PAGE === "cycle"
    ? "cycle-page"
    : TARGET_PAGE === "all"
      ? "all"
    : TARGET_PAGE === "all_month"
      ? "all-month"
    : TARGET_PAGE === "all_range"
      ? "all-range"
    : TARGET_PAGE === "power_analyze_month"
      ? "power-analyze-month"
    : TARGET_PAGE === "power_analyze_range"
      ? "power-analyze-range"
    : TARGET_PAGE === "power_analyze"
      ? "power-analyze"
    : TARGET_PAGE === "price"
      ? "price"
      : TARGET_PAGE === "energy_usage"
        ? "energy_usage"
    : TARGET_PAGE === "basic"
      ? "basic"
      : "today-dashboard";
const OUTPUT_PATH = path.join(OUTPUT_DIR, `${TARGET_BASENAME}.json`);
const CLEAN_OUTPUT_PATH = path.join(OUTPUT_DIR, `${TARGET_BASENAME}.cleaned.json`);
const CYCLE_NAV_TRACE_PATH = path.join(OUTPUT_DIR, "cycle-navigation-requests.json");
const CANDIDATE_SUCCESS_TEXT = ["登出", "登    出", "會員專區", "用電資料查詢"];
const DASHBOARD_TEXT = "本日用電儀表板";
const CYCLE_TEXT = "不同期間電費比較";
const USER_INFO_TEXT = "用戶資訊";
const USER_PROFILE_TEXT = "用戶資料";
const ENERGY_USAGE_TEXT = "用電紀錄";
const PRICE_RECORD_TEXT = "電費紀錄";
const POWER_ANALYZE_TEXT = "需量分析";
const FIFTEEN_MIN_TEXT = "每15分鐘";
const AUTH_TIMEOUT_MS = Number(process.env.HVCS_AUTH_TIMEOUT_MS || 180000);
const ELECTRIC_SELECTION_TIMEOUT_MS = Number(process.env.HVCS_ELECTRIC_SELECTION_TIMEOUT_MS || 120000);
const DASHBOARD_LOAD_TIMEOUT_MS = Number(process.env.HVCS_DASHBOARD_TIMEOUT_MS || 120000);
const BASE_NAVIGATION_TIMEOUT_MS = Number(process.env.HVCS_BASE_NAVIGATION_TIMEOUT_MS || 120000);
const BASE_NAVIGATION_RETRIES = Number(process.env.HVCS_BASE_NAVIGATION_RETRIES || 3);
const BASE_NAVIGATION_RETRY_DELAY_MS = Number(process.env.HVCS_BASE_NAVIGATION_RETRY_DELAY_MS || 3000);
const POWER_ANALYZE_DAY_TIMEOUT_MS = Number(process.env.HVCS_POWER_ANALYZE_DAY_TIMEOUT_MS || 240000);
const MANUAL_CYCLE_MONITOR = /^(1|true|yes)$/i.test((process.env.HVCS_MANUAL_TO_CYCLE || "").trim());
const DOMCONTENTLOADED_TIMEOUT_MS = Number(process.env.HVCS_DOMCONTENTLOADED_TIMEOUT_MS || 10000);
const NETWORKIDLE_TIMEOUT_MS = Number(process.env.HVCS_NETWORKIDLE_TIMEOUT_MS || 5000);
const GENERAL_RENDER_TIMEOUT_MS = 180000;
const AUTH_REQUIRED_HOOK = (process.env.HVCS_AUTH_REQUIRED_HOOK || "").trim();
const AUTH_RESOLVED_HOOK = (process.env.HVCS_AUTH_RESOLVED_HOOK || "").trim();
const PROGRESS_PATH = (process.env.HVCS_PROGRESS_PATH || "").trim();
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

function updateProgress(stage, message, extra = {}) {
  if (!PROGRESS_PATH) {
    return;
  }

  const payload = {
    updated_at: new Date().toISOString(),
    script: TARGET_PAGE,
    stage,
    message,
    target_page: TARGET_PAGE,
    ...extra,
  };

  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(payload, null, 2));
}

function buildContextOptions() {
  const options = {
    viewport: { width: 1440, height: 960 },
  };

  if (fs.existsSync(STORAGE_STATE_PATH)) {
    options.storageState = STORAGE_STATE_PATH;
  }

  return options;
}

function runHook(command, eventName) {
  if (!command) {
    return Promise.resolve();
  }

  log(`[hook] ${eventName}: ${command}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
        HVCS_HOOK_EVENT: eventName,
      },
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Hook failed for ${eventName} with exit code ${code}`));
    });
  });
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

function quoteEnvValue(value) {
  const raw = String(value || "");
  if (/^[A-Za-z0-9_.@:-]*$/.test(raw)) {
    return raw;
  }
  return JSON.stringify(raw);
}

function rememberEnvValue(key, value) {
  const rawValue = String(value || "").trim();
  if (!key || !rawValue) {
    return;
  }

  const nextLine = `${key}=${quoteEnvValue(rawValue)}`;
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, `${nextLine}\n`);
    return;
  }

  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  let replaced = false;
  const updated = lines.map((line) => {
    const separator = line.indexOf("=");
    if (separator === -1 || line.trim().startsWith("#")) {
      return line;
    }

    const existingKey = line.slice(0, separator).trim();
    if (existingKey !== key) {
      return line;
    }

    replaced = true;
    return nextLine;
  });

  if (!replaced) {
    updated.push(nextLine);
  }

  fs.writeFileSync(ENV_PATH, `${updated.join("\n").replace(/\n*$/, "")}\n`);
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

async function pageLooksLikeBasic(page) {
  if (page.url().includes(BASIC_PATH)) {
    return true;
  }

  const title = normalizeText(await page.title().catch(() => ""));
  if (title.includes("用戶資訊")) {
    return true;
  }

  const basicSignals = [
    page.getByText("帳號", { exact: false }).first(),
    page.getByText("電號", { exact: false }).first(),
    page.getByText("用戶資訊", { exact: false }).first(),
  ];

  for (const locator of basicSignals) {
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
  if (
    TARGET_PAGE === "power_analyze" ||
    TARGET_PAGE === "power_analyze_month" ||
    TARGET_PAGE === "power_analyze_range"
  ) {
    return pageLooksLikePowerAnalyze(page);
  }
  if (TARGET_PAGE === "all" || TARGET_PAGE === "all_month" || TARGET_PAGE === "all_range") {
    return pageLooksLikeBasic(page);
  }
  if (TARGET_PAGE === "energy_usage") {
    return pageLooksLikeEnergyUsage(page);
  }
  if (TARGET_PAGE === "price") {
    return pageLooksLikePrice(page);
  }
  if (TARGET_PAGE === "basic") {
    return pageLooksLikeBasic(page);
  }

  return pageLooksLikeDashboard(page);
}

async function pageLooksLikePowerAnalyze(page) {
  if (page.url().includes(POWER_ANALYZE_PATH)) {
    return true;
  }

  const title = normalizeText(await page.title().catch(() => ""));
  if (title.includes(POWER_ANALYZE_TEXT)) {
    return true;
  }

  return pageHasVisibleText(page, POWER_ANALYZE_TEXT);
}

async function pageLooksLikePrice(page) {
  if (!page.url().includes(BASIC_PATH)) {
    return false;
  }

  const billingSignals = [
    page.getByText(PRICE_RECORD_TEXT, { exact: false }).first(),
    page.getByText("應繳", { exact: false }).first(),
    page.getByText("繳費", { exact: false }).first(),
  ];

  for (const locator of billingSignals) {
    if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) {
      return true;
    }
  }

  const rows = page.locator("table tr");
  return (await rows.count().catch(() => 0)) > 1;
}

async function pageLooksLikeEnergyUsage(page) {
  if (!page.url().includes(BASIC_PATH)) {
    return false;
  }

  const usageSignals = [
    page.getByText(ENERGY_USAGE_TEXT, { exact: false }).first(),
    page.getByText("用電", { exact: false }).first(),
    page.getByText("度", { exact: false }).first(),
  ];

  for (const locator of usageSignals) {
    if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) {
      return true;
    }
  }

  const rows = page.locator("table tr");
  return (await rows.count().catch(() => 0)) > 1;
}

async function promptForManualNavigation(page, targetDescription, timeoutMs = DASHBOARD_LOAD_TIMEOUT_MS) {
  const context = page.context();
  const startUrl = page.url();
  const startText = await page.locator("body").innerText().catch(() => "");

  log(`Could not navigate automatically to ${targetDescription}.`);
  log("Navigate there manually in the browser.");
  log("The script will continue automatically once the page changes.");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    page = await getActivePage(context, page);
    await waitForPageSettled(page, 150);

    if (await pageLooksLikeTarget(page)) {
      return page;
    }

    const currentUrl = page.url();
    const currentText = await page.locator("body").innerText().catch(() => "");
    if (currentUrl !== startUrl || normalizeText(currentText) !== normalizeText(startText)) {
      return page;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(
    `Manual navigation to ${targetDescription} was not detected within ${Math.round(timeoutMs / 1000)} seconds.`
  );
}

async function gotoBaseUrlWithRetry(page) {
  let lastError;

  for (let attempt = 1; attempt <= BASE_NAVIGATION_RETRIES; attempt += 1) {
    try {
      await page.goto(BASE_URL, {
        waitUntil: "domcontentloaded",
        timeout: BASE_NAVIGATION_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      lastError = error;
      const finalAttempt = attempt === BASE_NAVIGATION_RETRIES;
      log(
        `Initial HVCS navigation attempt ${attempt}/${BASE_NAVIGATION_RETRIES} failed: ${error.message}`
      );
      if (finalAttempt) {
        break;
      }
      await page.waitForTimeout(BASE_NAVIGATION_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function waitForAuthenticated(page) {
  await gotoBaseUrlWithRetry(page);
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
  updateProgress("auth_saved", "Saved browser session state.", {
    storage_state_path: STORAGE_STATE_PATH,
  });
}

async function refreshSavedState(context, page, reason) {
  await saveState(context, page);
  updateProgress("auth_state_refreshed", `Refreshed saved auth state after ${reason}.`, {
    storage_state_path: STORAGE_STATE_PATH,
    page_url: page.url(),
    reason,
  });
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
  updateProgress("checking_auth", "Checking whether saved auth is still valid.");
  if (await waitForAuthenticated(page)) {
    updateProgress("auth_reused", "Saved auth is valid.", {
      page_url: page.url(),
    });
    return page;
  }

  log("Saved session is not authenticated.");
  log("A browser window will stay open so you can complete the HVCS login and captcha.");
  updateProgress("auth_required", "Saved auth is invalid; waiting for manual captcha/login.", {
    page_url: page.url(),
  });

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

  await runHook(AUTH_REQUIRED_HOOK, "auth_required");
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
  await runHook(AUTH_RESOLVED_HOOK, "auth_resolved");
  updateProgress("auth_refreshed", "Manual login completed and auth was refreshed.", {
    page_url: page.url(),
  });
  log(`Updated saved session at ${STORAGE_STATE_PATH}`);
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
    process.env.HVCS_ELECTRIC_NUMBER = selected;
    rememberEnvValue("HVCS_ELECTRIC_NUMBER", selected);
    log(`Detected electric-number context: ${selected}`);
    log(`Remembered HVCS_ELECTRIC_NUMBER in ${ENV_PATH}`);
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

  page = await chooseElectricNumber(context, page);

  if (TARGET_PAGE === "dashboard" && (await pageLooksLikeTarget(page))) {
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
      return await promptForManualNavigation(page, `\`${CYCLE_TEXT}\``);
    }

    return page;
  }

  if (TARGET_PAGE === "power_analyze" || TARGET_PAGE === "power_analyze_month") {
    const startUrl = page.url();
    const startText = await page.locator("body").innerText().catch(() => "");

    await page.goto(`https://service.taipower.com.tw${POWER_ANALYZE_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForPageSettled(page);
    await waitForPowerAnalyzeRendered(page, startText, GENERAL_RENDER_TIMEOUT_MS);

    const analyzePage = await waitForTargetTransition(context, page, startUrl, startText);
    if (analyzePage) {
      return analyzePage;
    }

    return await promptForManualNavigation(page, "`需量分析`");
  }

  if (TARGET_PAGE === "basic") {
    const startUrl = page.url();
    const startText = await page.locator("body").innerText().catch(() => "");

    await page.goto(`https://service.taipower.com.tw${BASIC_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForPageSettled(page);

    const basicPage = await waitForTargetTransition(context, page, startUrl, startText);
    if (basicPage) {
      page = basicPage;
    }

    const profileStartUrl = page.url();
    const profileStartText = await page.locator("body").innerText().catch(() => "");
    if (!(await clickByText(page, USER_PROFILE_TEXT))) {
      return await promptForManualNavigation(page, `\`${USER_PROFILE_TEXT}\``);
    }

    const profilePage = await waitForTargetTransition(context, page, profileStartUrl, profileStartText);
    return profilePage || page;
  }

  if (TARGET_PAGE === "all" || TARGET_PAGE === "all_month" || TARGET_PAGE === "all_range") {
    await page.goto(`https://service.taipower.com.tw${BASIC_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForPageSettled(page);
    return page;
  }

  if (TARGET_PAGE === "energy_usage") {
    await page.goto(`https://service.taipower.com.tw${BASIC_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForPageSettled(page);

    const startUrl = page.url();
    const startText = await page.locator("body").innerText().catch(() => "");

    if (!(await clickByText(page, ENERGY_USAGE_TEXT))) {
      return await promptForManualNavigation(page, `\`${ENERGY_USAGE_TEXT}\``);
    }
    await waitForTabRendered(page, normalizeText(startText), GENERAL_RENDER_TIMEOUT_MS);

    const usagePage = await waitForTargetTransition(context, page, startUrl, startText);
    if (usagePage) {
      return usagePage;
    }

    return await promptForManualNavigation(page, `\`${ENERGY_USAGE_TEXT}\``);
  }

  if (TARGET_PAGE === "price") {
    const basicStartUrl = page.url();
    const basicStartText = await page.locator("body").innerText().catch(() => "");

    await page.goto(`https://service.taipower.com.tw${BASIC_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForPageSettled(page);

    const basicPage = await waitForTargetTransition(context, page, basicStartUrl, basicStartText);
    page = basicPage || page;

    const startUrl = page.url();
    const startText = await page.locator("body").innerText().catch(() => "");

    if (!(await clickByText(page, PRICE_RECORD_TEXT))) {
      return await promptForManualNavigation(page, `\`${PRICE_RECORD_TEXT}\``);
    }
    await waitForTabRendered(page, normalizeText(startText), GENERAL_RENDER_TIMEOUT_MS);

    const pricePage = await waitForTargetTransition(context, page, startUrl, startText);
    if (pricePage) {
      return pricePage;
    }

    return await promptForManualNavigation(page, `\`${PRICE_RECORD_TEXT}\``);
  }

  const startUrl = page.url();
  const startText = await page.locator("body").innerText().catch(() => "");

  if (!(await clickByText(page, DASHBOARD_TEXT))) {
    page = await promptForManualNavigation(page, "`本日用電儀表板`");
  } else {
    const dashboardPage = await waitForTargetTransition(context, page, startUrl, startText);
    page = dashboardPage || page;
  }

  return page;
}

async function collectTables(page, options = {}) {
  const { visibleOnly = false } = options;
  return page.$$eval(
    "table",
    (tables, runtimeOptions) => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      const shouldCheckVisibility = Boolean(runtimeOptions?.visibleOnly);
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }

        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const buildExpandedRows = (table) => {
        const trNodes = Array.from(table.querySelectorAll("tr"));
        const grid = [];

        for (let rowIndex = 0; rowIndex < trNodes.length; rowIndex += 1) {
          if (!grid[rowIndex]) {
            grid[rowIndex] = [];
          }

          const row = grid[rowIndex];
          let colIndex = 0;
          while (row[colIndex] !== undefined) {
            colIndex += 1;
          }

          const cells = Array.from(trNodes[rowIndex].querySelectorAll("th, td"));
          for (const cell of cells) {
            while (row[colIndex] !== undefined) {
              colIndex += 1;
            }

            const text = normalize(cell.textContent || "");
            const rowSpan = Math.max(1, Number(cell.getAttribute("rowspan")) || 1);
            const colSpan = Math.max(1, Number(cell.getAttribute("colspan")) || 1);

            for (let r = 0; r < rowSpan; r += 1) {
              const targetRowIndex = rowIndex + r;
              if (!grid[targetRowIndex]) {
                grid[targetRowIndex] = [];
              }
              for (let c = 0; c < colSpan; c += 1) {
                // Keep the value in the first spanned column only.
                // Additional colspan columns are structural placeholders.
                grid[targetRowIndex][colIndex + c] = c === 0 ? text : "";
              }
            }

            colIndex += colSpan;
          }
        }

        const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
        return grid
          .map((row) => {
            const cells = [];
            for (let index = 0; index < width; index += 1) {
              cells.push(normalize(row[index] || ""));
            }
            return cells;
          })
          .filter((row) => row.some(Boolean));
      };

      const result = [];
      for (let index = 0; index < tables.length; index += 1) {
        const table = tables[index];
        if (shouldCheckVisibility && !isVisible(table)) {
          continue;
        }

        const rows = buildExpandedRows(table);

        if (!rows.length) {
          continue;
        }

        const headers = rows[0] || [];

        result.push({
          index,
          headers,
          rows,
        });
      }

      return result;
    },
    { visibleOnly }
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

function rowsContainSameValues(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => normalizeText(value) === normalizeText(right[index]));
}

function rowsToRecordObjects(headers, rows) {
  const normalizedHeaders = [];
  const seen = new Map();

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    let key = normalizeRecordKey(header);
    if (!key) {
      key = `col_${index + 1}`;
    }

    const used = seen.get(key) || 0;
    seen.set(key, used + 1);
    normalizedHeaders.push(used === 0 ? key : `${key}_${used + 1}`);
  }

  return rows.map((row) =>
    Object.fromEntries(normalizedHeaders.map((key, index) => [key, row[index] || ""]))
  );
}

function normalizeRecordKey(header) {
  const text = normalizeText(header);
  if (!text) return "";

  const compact = text.replace(/\s+/g, "").toLowerCase();

  if (compact.includes("co2排放量") && compact.includes("kg")) {
    return "co2排放量_kg";
  }
  if (compact.includes("基本電費") && compact.includes("約定")) {
    return "基本電費_約定";
  }
  if (compact.includes("基本電費") && compact.includes("非約定")) {
    return "基本電費_非約定";
  }
  if (compact.includes("加減收項金額")) {
    return "加減收項金額_備註";
  }

  return text
    .replace(/[()（）]/g, "_")
    .replace(/[\/\\]/g, "_")
    .replace(/\s+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeTableRows(rawRows) {
  return (rawRows || [])
    .map((row) => row.map((cell) => normalizeText(cell)))
    .filter((row) => row.some(Boolean));
}

function parseSectionedTable(rawRows, fallbackSection) {
  const rows = normalizeTableRows(rawRows);
  if (!rows.length) {
    return null;
  }

  let section = fallbackSection || "";
  let dataRows = rows;

  if (rows[0].length === 1 && rows[0][0]) {
    section = rows[0][0];
    dataRows = rows.slice(1);
  }

  if (!dataRows.length) {
    return null;
  }

  const headers = dataRows[0] || [];
  let values = dataRows.slice(1);

  if (!headers.length) {
    return null;
  }

  if (values.length && rowsContainSameValues(values[0], headers)) {
    values = values.slice(1);
  }

  const records = rowsToRecordObjects(headers, values);
  if (!records.length) {
    return null;
  }

  return {
    section: section || fallbackSection || "",
    records,
  };
}

function parseBasicInfoKeyValueTable(rawRows) {
  const rows = normalizeTableRows(rawRows);
  if (!rows.length) {
    return null;
  }

  // Skip section-title row when present (single-cell "基本資料")
  const dataRows =
    rows[0].length === 1 && normalizeText(rows[0][0]).includes("基本資料")
      ? rows.slice(1)
      : rows;

  const record = {};
  for (const row of dataRows) {
    for (let index = 0; index < row.length; index += 2) {
      const key = normalizeText(row[index] || "");
      if (!key) continue;
      const value = normalizeText(row[index + 1] || "");
      record[normalizeRecordKey(key) || key] = value;
    }
  }

  if (!Object.keys(record).length) {
    return null;
  }

  return {
    section: "基本資料",
    records: [record],
  };
}

function pickBasicSectionName(tableText) {
  if (tableText.includes("基本資料") || tableText.includes("用電地址")) {
    return "基本資料";
  }
  if (tableText.includes("設備容量") || (tableText.includes("電力") && tableText.includes("電熱"))) {
    return "設備容量";
  }
  if (tableText.includes("契約容量") || tableText.includes("經常契約容量")) {
    return "契約容量";
  }
  return "";
}

function isBackupLabelValue(value) {
  return normalizeText(value).includes("備用");
}

function isKwValue(value) {
  const text = normalizeText(value);
  return /kW$/i.test(text) || /^-?\d[\d,]*(\.\d+)?$/.test(text);
}

function mergeContractCapacityRecords(records) {
  const result = [];

  for (let index = 0; index < records.length; index += 1) {
    const current = records[index];
    const next = records[index + 1];

    if (!current || !next) {
      result.push(current);
      continue;
    }

    const keys = Object.keys(current);
    const currentLooksLikeBackupLabels =
      keys.length > 0 &&
      keys.every((key) => isBackupLabelValue(current[key] || ""));

    const nextLooksLikeKwValues =
      keys.length > 0 &&
      keys.every((key) => isKwValue(next[key] || ""));

    if (currentLooksLikeBackupLabels && nextLooksLikeKwValues) {
      const merged = {};
      for (const key of keys) {
        const mergedKey = normalizeRecordKey(current[key] || "") || normalizeRecordKey(key) || key;
        merged[mergedKey] = next[key] || "";
      }
      result.push(merged);
      index += 1;
      continue;
    }

    result.push(current);
  }

  return result.filter(Boolean);
}

function normalizeBasicSections(sections) {
  return (sections || []).map((section) => {
    if ((section?.section || "") !== "契約容量") {
      return section;
    }

    return {
      ...section,
      records: mergeContractCapacityRecords(Array.isArray(section.records) ? section.records : []),
    };
  });
}

async function extractBasicSections(page) {
  const tables = await collectTables(page, { visibleOnly: true });
  if (!tables.length) {
    return [];
  }

  const sections = tables
    .map((table) => {
      const tableText = normalizeText([...(table.headers || []), ...table.rows.flat()].join(" "));
      const section = pickBasicSectionName(tableText);
      if (!section) return null;
      if (section === "基本資料") {
        return parseBasicInfoKeyValueTable(table.rows);
      }
      return parseSectionedTable(table.rows, section);
    })
    .filter(Boolean);

  return normalizeBasicSections(sections);
}

async function extractSingleSectionTableByHints(page, sectionName, hints = []) {
  const tables = await collectTables(page, { visibleOnly: true });
  if (!tables.length) {
    return [];
  }

  const normalizedHints = hints.map((hint) => normalizeText(hint));
  const scored = tables
    .map((table) => {
      if (!table.rows.length) return null;
      const text = normalizeText([...(table.headers || []), ...table.rows.flat()].join(" "));
      const score = normalizedHints.length
        ? normalizedHints.reduce((sum, hint) => sum + (text.includes(hint) ? 1 : 0), 0)
        : 1;
      if (score === 0) return null;
      return { table, score };
    })
    .filter(Boolean);

  if (!scored.length) {
    return [];
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return (right.table.rows?.length || 0) - (left.table.rows?.length || 0);
  });

  const parsed = scored
    .map((item) => parseSectionedTable(item.table.rows, sectionName))
    .filter(Boolean);

  if (!parsed.length) {
    return [];
  }

  parsed.sort((a, b) => (b.records?.length || 0) - (a.records?.length || 0));
  return [parsed[0]];
}

function isMonthLabel(value) {
  return /^\d{1,2}月$/.test(normalizeText(value));
}

function looksLikeBillingPeriod(value) {
  const text = normalizeText(value);
  return text.includes("~") || /\d{2,3}\/\d{1,2}\/\d{1,2}/.test(text);
}

function inferEnergyItemLabel(row) {
  const candidateItem = normalizeText(row["項目"]);
  if (candidateItem && !/^\d[\d,]*(\.\d+)?$/.test(candidateItem)) {
    return candidateItem;
  }

  const monthCol = normalizeText(row["電費月份"]);
  if (/用電度數|轉供度數|最高需量/.test(monthCol)) {
    return monthCol;
  }

  return candidateItem || monthCol || "項目";
}

function aggregateEnergyUsageSections(sections) {
  return (sections || []).map((section) => {
    const records = Array.isArray(section.records) ? section.records : [];
    const byMonth = new Map();
    let currentMonth = "";
    let summary = null;

    for (const row of records) {
      const monthCol = normalizeText(row["電費月份"]);
      const periodCol = normalizeText(row["計費期間"]);

      if (isMonthLabel(monthCol)) {
        currentMonth = monthCol;
      }

      if (!currentMonth) {
        if (periodCol.includes("合計")) {
          summary = {
            label: periodCol,
            尖峰: row["尖峰"] || "",
            半尖峰: row["半尖峰"] || "",
            週六半尖峰: row["週六半尖峰"] || "",
            離峰: row["離峰"] || "",
            co2排放量_kg: row["co2排放量_kg"] || "",
          };
        }
        continue;
      }

      if (!byMonth.has(currentMonth)) {
        byMonth.set(currentMonth, {
          電費月份: currentMonth,
          計費期間: looksLikeBillingPeriod(periodCol) ? periodCol : "",
          co2排放量_kg: "",
          明細: [],
        });
      }

      const bucket = byMonth.get(currentMonth);
      if (!bucket["計費期間"] && looksLikeBillingPeriod(periodCol)) {
        bucket["計費期間"] = periodCol;
      }
      if (!bucket["co2排放量_kg"] && normalizeText(row["co2排放量_kg"])) {
        bucket["co2排放量_kg"] = normalizeText(row["co2排放量_kg"]);
      }

      const detail = {
        項目: inferEnergyItemLabel(row),
        尖峰: row["尖峰"] || "",
        半尖峰: row["半尖峰"] || "",
        週六半尖峰: row["週六半尖峰"] || "",
        離峰: row["離峰"] || "",
      };

      if (row["項目"] && /^\d[\d,]*(\.\d+)?$/.test(normalizeText(row["項目"]))) {
        detail["總計"] = row["項目"];
      }

      bucket["明細"].push(detail);
    }

    const aggregated = {
      section: section.section || "用電紀錄",
      records: Array.from(byMonth.values()),
    };

    if (summary) {
      aggregated.summary = summary;
    }

    return aggregated;
  });
}

function getYesterdayInfo() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  const rocYear = String(year - 1911);
  const rocDate = `${rocYear}/${month}/${day}`;
  const isoDate = `${year}-${month}-${day}`;
  const slashDate = `${year}/${month}/${day}`;

  return {
    isoDate,
    slashDate,
    rocDate,
  };
}

function parseTargetPowerAnalyzeDate() {
  const raw = normalizeText(process.env.HVCS_POWER_ANALYZE_DATE || "");
  if (!raw) {
    return getYesterdayInfo();
  }

  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) {
    throw new Error("HVCS_POWER_ANALYZE_DATE must use YYYY-MM-DD format.");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(year, month - 1, day);
  candidate.setHours(0, 0, 0, 0);

  if (
    Number.isNaN(candidate.getTime()) ||
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    throw new Error("HVCS_POWER_ANALYZE_DATE is not a valid calendar date.");
  }

  const yesterday = new Date();
  yesterday.setHours(0, 0, 0, 0);
  yesterday.setDate(yesterday.getDate() - 1);
  if (candidate.getTime() > yesterday.getTime()) {
    throw new Error("HVCS_POWER_ANALYZE_DATE cannot be later than yesterday.");
  }

  return buildDateInfo(year, month, day);
}

function parseTargetMonth() {
  const raw = normalizeText(process.env.HVCS_POWER_ANALYZE_MONTH || "");
  const match = raw.match(/^(\d{4})[-/](\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year >= 2000 && year <= 3000 && month >= 1 && month <= 12) {
      return { year, month };
    }
  }

  const ystd = getYesterdayInfo().isoDate;
  return {
    year: Number(ystd.slice(0, 4)),
    month: Number(ystd.slice(5, 7)),
  };
}

function parseExactPowerAnalyzeDate(rawValue, envName) {
  const raw = normalizeText(rawValue || "");
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) {
    throw new Error(`${envName} must use YYYY-MM-DD format.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(year, month - 1, day);
  candidate.setHours(0, 0, 0, 0);

  if (
    Number.isNaN(candidate.getTime()) ||
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    throw new Error(`${envName} is not a valid calendar date.`);
  }

  const yesterday = new Date();
  yesterday.setHours(0, 0, 0, 0);
  yesterday.setDate(yesterday.getDate() - 1);
  if (candidate.getTime() > yesterday.getTime()) {
    throw new Error(`${envName} cannot be later than yesterday.`);
  }

  return buildDateInfo(year, month, day);
}

function parseTargetPowerAnalyzeRange() {
  const start = parseExactPowerAnalyzeDate(
    process.env.HVCS_POWER_ANALYZE_START_DATE || "",
    "HVCS_POWER_ANALYZE_START_DATE"
  );
  const end = parseExactPowerAnalyzeDate(
    process.env.HVCS_POWER_ANALYZE_END_DATE || "",
    "HVCS_POWER_ANALYZE_END_DATE"
  );

  if (start.isoDate > end.isoDate) {
    throw new Error("HVCS_POWER_ANALYZE_START_DATE cannot be later than HVCS_POWER_ANALYZE_END_DATE.");
  }

  return { start, end };
}
function parseOptionalPositiveIntEnv(name) {
  const raw = normalizeText(process.env[name] || "");
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(raw);
}

function parseBillingPeriodDate(rawValue, fieldName) {
  const raw = normalizeText(rawValue || "");
  const match = raw.match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) {
    throw new Error(`Invalid billing period ${fieldName}: ${raw}.`);
  }

  const parsedYear = Number(match[1]);
  const year = parsedYear < 1911 ? parsedYear + 1911 : parsedYear;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return buildDateInfo(year, month, day);
}

function parseBillingPeriodRange(rawValue) {
  const raw = normalizeText(rawValue || "");
  const match = raw.match(/(\d{2,4}\/\d{1,2}\/\d{1,2})\s*~\s*(\d{2,4}\/\d{1,2}\/\d{1,2})/);
  if (!match) return null;
  const start = parseBillingPeriodDate(match[1], "start");
  const end = parseBillingPeriodDate(match[2], "end");
  if (start.isoDate > end.isoDate) {
    throw new Error(`Invalid billing period range: ${raw}.`);
  }
  return { start, end, raw };
}

function parseBillingMonthLabel(rawValue) {
  const raw = normalizeText(rawValue || "");
  if (raw.length > 6) return null;
  const match = raw.match(/^(\d{1,2})\D+$/);
  if (!match) return null;
  const month = Number(match[1]);
  return month >= 1 && month <= 12 ? month : null;
}

function flattenPrimitiveObjects(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenPrimitiveObjects(item, out));
    return out;
  }

  if (!value || typeof value !== "object") {
    return out;
  }

  const entries = Object.entries(value);
  if (entries.length && entries.every(([, item]) => item == null || typeof item !== "object")) {
    out.push(value);
  }

  for (const [, item] of entries) {
    flattenPrimitiveObjects(item, out);
  }
  return out;
}

function extractBillingPeriodsFromBasicAllPayload(payload) {
  const rows = flattenPrimitiveObjects(payload?.price || payload);
  const periods = [];

  for (const row of rows) {
    const values = Object.values(row).map((value) => normalizeText(value));
    const billMonth = values.map(parseBillingMonthLabel).find((value) => value != null);
    const period = values.map(parseBillingPeriodRange).find(Boolean);
    if (!billMonth || !period) continue;

    periods.push({
      bill_month: billMonth,
      start: period.start,
      end: period.end,
      raw_period: period.raw,
    });
  }

  periods.sort((left, right) => left.bill_month - right.bill_month);
  return periods;
}

function readBillingPeriodsFromBasicAllArtifact(basicAllJsonPath) {
  const payload = JSON.parse(fs.readFileSync(basicAllJsonPath, "utf8"));
  const periods = extractBillingPeriodsFromBasicAllPayload(payload);
  if (!periods.length) {
    throw new Error(`No billing periods were found in ${basicAllJsonPath}.`);
  }
  return periods;
}

function resolveTargetPowerAnalyzeRangeFromBasicAll(basicAllJsonPath) {
  const explicitStart = normalizeText(process.env.HVCS_POWER_ANALYZE_START_DATE || "");
  const explicitEnd = normalizeText(process.env.HVCS_POWER_ANALYZE_END_DATE || "");
  if (explicitStart || explicitEnd) {
    return { ...parseTargetPowerAnalyzeRange(), source: "explicit_dates" };
  }

  const billMonth = parseOptionalPositiveIntEnv("HVCS_BILL_MONTH");
  const billYear = normalizeText(process.env.HVCS_BILL_YEAR || process.env.HVCS_BASIC_ALL_YEAR || "");
  if (!billMonth && !billYear) {
    throw new Error(
      "Set either HVCS_POWER_ANALYZE_START_DATE/HVCS_POWER_ANALYZE_END_DATE, HVCS_BILL_MONTH, or HVCS_BILL_YEAR for all_range."
    );
  }

  const periods = readBillingPeriodsFromBasicAllArtifact(basicAllJsonPath);

  if (billMonth) {
    if (billMonth < 1 || billMonth > 12) {
      throw new Error("HVCS_BILL_MONTH must be between 1 and 12.");
    }
    const match = periods.find((period) => period.bill_month === billMonth);
    if (!match) {
      throw new Error(`Bill month ${billMonth} was not found in ${basicAllJsonPath}.`);
    }
    return { start: match.start, end: match.end, bill_month: billMonth, source: "bill_month" };
  }

  const start = periods.reduce((earliest, period) => (period.start.isoDate < earliest.isoDate ? period.start : earliest), periods[0].start);
  const end = periods.reduce((latest, period) => (period.end.isoDate > latest.isoDate ? period.end : latest), periods[0].end);
  return {
    start,
    end,
    bill_year: billYear,
    bill_months: periods.map((period) => period.bill_month),
    source: "bill_year",
  };
}

function buildDateInfo(year, month, day) {
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const isoDate = `${yyyy}-${mm}-${dd}`;
  const slashDate = `${yyyy}/${mm}/${dd}`;
  const rocDate = `${year - 1911}/${mm}/${dd}`;
  return { isoDate, slashDate, rocDate };
}

function listMonthDates(year, month) {
  const count = new Date(year, month, 0).getDate();
  const result = [];
  const yesterday = new Date();
  yesterday.setHours(0, 0, 0, 0);
  yesterday.setDate(yesterday.getDate() - 1);

  for (let day = 1; day <= count; day += 1) {
    const candidate = new Date(year, month - 1, day);
    candidate.setHours(0, 0, 0, 0);
    if (candidate.getTime() > yesterday.getTime()) {
      break;
    }
    result.push(buildDateInfo(year, month, day));
  }
  return result;
}

function listDateRange(startDateInfo, endDateInfo) {
  const result = [];
  const cursor = new Date(startDateInfo.isoDate);
  const end = new Date(endDateInfo.isoDate);

  while (cursor.getTime() <= end.getTime()) {
    result.push(
      buildDateInfo(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate())
    );
    cursor.setDate(cursor.getDate() + 1);
  }

  return result;
}

async function ensurePowerAnalyzeFifteenMin(page) {
  const beforeFifteenText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const clickedFifteen = await clickByText(page, FIFTEEN_MIN_TEXT);
  if (!clickedFifteen) {
    return false;
  }
  await waitForPageSettled(page, 600);
  return waitForPowerAnalyzeRendered(page, beforeFifteenText, GENERAL_RENDER_TIMEOUT_MS);
}

async function runPowerAnalyzeQueryByDate(page, dateInfo) {
  const beforeQueryText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  await setPowerAnalyzeDate(page, dateInfo).catch(() => {});
  await waitForPageSettled(page, 400);
  await clickPowerAnalyzeQuery(page).catch(() => {});
  await waitForPageSettled(page, 700);
  return waitForPowerAnalyzeRendered(
    page,
    beforeQueryText,
    GENERAL_RENDER_TIMEOUT_MS,
    dateInfo.isoDate
  );
}

async function runPowerAnalyzeQueryByDateWithTimeout(page, dateInfo) {
  let timeoutId;

  try {
    return await Promise.race([
      runPowerAnalyzeQueryByDate(page, dateInfo),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `PowerAnalyze query timed out after ${Math.round(
                POWER_ANALYZE_DAY_TIMEOUT_MS / 1000
              )} seconds for ${dateInfo.slashDate}`
            )
          );
        }, POWER_ANALYZE_DAY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function selectPowerAnalyzeYstdAndFifteenMin(page) {
  await ensurePowerAnalyzeFifteenMin(page);
  const targetDate = parseTargetPowerAnalyzeDate();
  return runPowerAnalyzeQueryByDate(page, targetDate);
}

async function setPowerAnalyzeDate(page, dateInfo) {
  const yearNum = String(Number(dateInfo.isoDate.slice(0, 4)));
  const monthNum = String(Number(dateInfo.isoDate.slice(5, 7)));
  const dayNum = String(Number(dateInfo.isoDate.slice(8, 10)));

  await page.evaluate(
    ({ year, month, day, iso }) => {
      const normalize = (value) => String(value ?? "").replace(/\s+/g, "").trim();
      const dispatch = (el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      // Preferred path: three dropdowns for year/month/day.
      const selects = Array.from(document.querySelectorAll("select")).filter((el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      const setSelect = (target, desired) => {
        if (!target) return false;
        const options = Array.from(target.options || []);
        const match = options.find((opt) => normalize(opt.value) === desired || normalize(opt.textContent) === desired);
        if (!match) return false;
        target.value = match.value;
        dispatch(target);
        return true;
      };

      if (selects.length >= 3) {
        setSelect(selects[0], year);
        setSelect(selects[1], month);
        setSelect(selects[2], day);
      }

      // Fallback: date input (if exists).
      const dateInput = document.querySelector('input[type="date"]');
      if (dateInput) {
        dateInput.value = iso;
        dispatch(dateInput);
      }
    },
    { year: yearNum, month: monthNum, day: dayNum, iso: dateInfo.isoDate }
  );
}

async function clickPowerAnalyzeQuery(page) {
  if (await clickByText(page, "查詢")) {
    return true;
  }

  const clicked = await page
    .evaluate(() => {
      const normalize = (value) => String(value ?? "").replace(/\s+/g, "").trim();
      const candidates = Array.from(
        document.querySelectorAll('button, input[type="button"], input[type="submit"], a')
      );
      for (const node of candidates) {
        const text = normalize(node.textContent || node.getAttribute("value") || "");
        if (!text.includes("查詢")) continue;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        node.click();
        return true;
      }
      return false;
    })
    .catch(() => false);

  return clicked;
}

async function pageHasPowerAnalyzeResult(page, initialText) {
  const currentText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const contentChanged = currentText !== initialText;

  const hasLoadingText = /載入中|讀取中|處理中|loading/i.test(currentText);
  if (hasLoadingText) {
    return false;
  }

  const hasVisibleRows = await page
    .evaluate(() => {
      const tables = Array.from(document.querySelectorAll("table"));
      const visibleTables = tables.filter((table) => {
        const style = window.getComputedStyle(table);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = table.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      const rowCount = visibleTables.reduce(
        (sum, table) => sum + table.querySelectorAll("tr").length,
        0
      );
      return rowCount >= 3;
    })
    .catch(() => false);

  const hasChartCanvas = await page
    .evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("svg, canvas, .highcharts-container"));
      return nodes.some((node) => {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    })
    .catch(() => false);

  if (hasVisibleRows || hasChartCanvas) {
    return true;
  }

  return contentChanged && !hasLoadingText;
}

async function pageContainsPowerAnalyzeDate(page, isoDate) {
  const slashDate = isoDate.replace(/-/g, "/");
  const text = normalizeText(await page.locator("body").innerText().catch(() => ""));
  return text.includes(isoDate) || text.includes(slashDate);
}

async function waitForPowerAnalyzeRendered(page, initialText, timeoutMs, expectedIsoDate = "") {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await waitForPageSettled(page, 300);

    if (await pageHasPowerAnalyzeResult(page, initialText)) {
      if (expectedIsoDate) {
        if (!(await pageContainsPowerAnalyzeDate(page, expectedIsoDate))) {
          await page.waitForTimeout(800);
          continue;
        }
      }
      // Give client-side chart/table one more beat to stabilize.
      await page.waitForTimeout(1200);
      return true;
    }

    await page.waitForTimeout(1000);
  }

  log(
    `PowerAnalyze result was not fully detected within ${Math.round(
      timeoutMs / 1000
    )} seconds. Continuing with current page state.`
  );
  return false;
}

async function waitForTabRendered(page, initialText, timeoutMs = GENERAL_RENDER_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await waitForPageSettled(page, 250);
    const currentText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    const hasLoadingText = /載入中|讀取中|處理中|loading/i.test(currentText);

    if (!hasLoadingText && currentText !== initialText) {
      await page.waitForTimeout(800);
      return true;
    }

    await page.waitForTimeout(900);
  }

  log(
    `Tab render was not fully detected within ${Math.round(
      timeoutMs / 1000
    )} seconds. Continuing with current page state.`
  );
  return false;
}

function rowsToRecordObjectsWithHeaders(headers, rows) {
  const keys = headers.map((header, index) => normalizeRecordKey(header) || `col_${index + 1}`);
  return rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index] || ""])));
}

async function extractVisibleTablesAsSections(page, defaultSection) {
  const tables = await collectTables(page, { visibleOnly: true });
  return tables
    .map((table) => {
      const sectionCandidate = normalizeText(table.rows?.[0]?.[0] || "");
      const parsed = parseSectionedTable(table.rows, sectionCandidate || defaultSection);
      if (parsed) return parsed;

      const headers = table.headers.length ? table.headers : table.rows[0] || [];
      let values = table.rows.slice(1);
      if (headers.length && values.length && rowsContainSameValues(values[0], headers)) {
        values = values.slice(1);
      }
      const records = rowsToRecordObjectsWithHeaders(headers, values);
      if (!records.length) return null;
      return { section: defaultSection, records };
    })
    .filter(Boolean);
}

async function openBasicTab(page, tabText) {
  const startUrl = page.url();
  const startText = await page.locator("body").innerText().catch(() => "");

  if (!(await clickByText(page, tabText))) {
    return await promptForManualNavigation(page, `\`${tabText}\``);
  }

  await waitForPageSettled(page);

  if (page.url() !== startUrl) {
    return page;
  }

  const currentText = await page.locator("body").innerText().catch(() => "");
  if (normalizeText(currentText) !== normalizeText(startText)) {
    return page;
  }

  await page.waitForTimeout(1200);
  return page;
}

function writeOutputJson(fileName, payload) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, fileName);
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  return outputPath;
}

function writeArtifactJson(pathParts, payload) {
  const artifactPath = path.join(ARTIFACTS_DIR, ...pathParts);
  const enrichedPayload = {
    updated_at: new Date().toISOString(),
    ...payload,
  };
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(enrichedPayload, null, 2));
  return artifactPath;
}

function sanitizeArtifactSegment(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/]/g, "-");
  return normalized || fallback;
}

function resolveArtifactElectricNumber(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return sanitizeArtifactSegment(digits, "unknown-electric-number");
}

async function detectCurrentElectricNumber(page) {
  const html = await page.content().catch(() => "");
  const fromStrong =
    html.match(/電號[\s\S]{0,200}?<strong[^>]*class="text-danger"[^>]*>(\d+)<\/strong>/)?.[1] || "";
  if (fromStrong) {
    return fromStrong;
  }

  const text = await page.locator("body").innerText().catch(() => "");
  const fromText = text.match(/電號[:：]?\s*(\d{8,})/)?.[1] || "";
  return fromText || (process.env.HVCS_ELECTRIC_NUMBER || "").trim() || null;
}

async function detectSelectedYear(page) {
  const selectedYear = await page
    .evaluate(() => {
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const selects = Array.from(document.querySelectorAll("select")).filter(isVisible);
      for (const select of selects) {
        const option = select.options[select.selectedIndex];
        const selected = normalize(option?.value || option?.textContent || "");
        if (!/^\d{4}$/.test(selected)) continue;

        const localText = normalize(
          [
            select.parentElement?.textContent || "",
            select.previousElementSibling?.textContent || "",
            select.nextElementSibling?.textContent || "",
          ].join(" ")
        );
        if (localText.includes("年")) {
          return selected;
        }
      }

      return "";
    })
    .catch(() => "");

  if (selectedYear) {
    return selectedYear;
  }

  const text = await page.locator("body").innerText().catch(() => "");
  return text.match(/\b(20\d{2})\b\s*年/)?.[1] || null;
}

function buildBasicAllArtifactPath(electricNumber, selectedYear) {
  return ["hvcs-basic-all", resolveArtifactElectricNumber(electricNumber), `${selectedYear}.json`];
}

function buildPowerAnalyzeDayArtifactPath(electricNumber, dateInfo) {
  return ["hvcs-power-analyze-day", resolveArtifactElectricNumber(electricNumber), `${dateInfo.isoDate}.json`];
}

function buildPowerAnalyzeMonthArtifactPath(electricNumber, targetMonth) {
  const yyyy = String(targetMonth.year).padStart(4, "0");
  const mm = String(targetMonth.month).padStart(2, "0");
  return ["hvcs-power-analyze-month", resolveArtifactElectricNumber(electricNumber), `${yyyy}-${mm}.json`];
}

function buildPowerAnalyzeRangeArtifactPath(electricNumber, startDateInfo, endDateInfo) {
  return [
    "hvcs-power-analyze-range",
    resolveArtifactElectricNumber(electricNumber),
    `${startDateInfo.isoDate}_to_${endDateInfo.isoDate}.json`,
  ];
}

function parseTargetBasicAllYear() {
  const raw = String(process.env.HVCS_BASIC_ALL_YEAR || "").trim();
  if (!raw) return null;
  if (!/^\d{4}$/.test(raw)) {
    throw new Error(`Invalid HVCS_BASIC_ALL_YEAR: ${raw}. Expected YYYY.`);
  }
  const year = Number(raw);
  if (year < 2000 || year > 3000) {
    throw new Error(`Invalid HVCS_BASIC_ALL_YEAR: ${raw}. Expected YYYY between 2000 and 3000.`);
  }
  return String(year);
}

async function selectBasicAllYear(page, targetYear) {
  if (!targetYear) {
    return false;
  }

  const changed = await page
    .evaluate((desiredYear) => {
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const dispatch = (el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      const selects = Array.from(document.querySelectorAll("select")).filter(isVisible);
      for (const select of selects) {
        const option = select.options[select.selectedIndex];
        const selected = normalize(option?.value || option?.textContent || "");
        const localText = normalize(
          [
            select.parentElement?.textContent || "",
            select.previousElementSibling?.textContent || "",
            select.nextElementSibling?.textContent || "",
          ].join(" ")
        );
        if (!localText.includes("年")) continue;

        const options = Array.from(select.options || []);
        const match = options.find((opt) => {
          const value = normalize(opt.value);
          const text = normalize(opt.textContent);
          return value === desiredYear || text === desiredYear || text === `${desiredYear} 年`;
        });
        if (!match) continue;

        if (selected === desiredYear || selected === `${desiredYear} 年`) {
          return false;
        }

        select.value = match.value;
        dispatch(select);
        return true;
      }

      return false;
    }, targetYear)
    .catch(() => false);

  if (changed) {
    await waitForPageSettled(page, 700);
  }

  return changed;
}

async function saveBasicAllArtifact(page, context) {
  const targetBasicAllYear = parseTargetBasicAllYear();
  await openBasicTab(page, USER_PROFILE_TEXT);
  const basicTables = await extractBasicSections(page);
  const electricNumber = await detectCurrentElectricNumber(page);

  await openBasicTab(page, ENERGY_USAGE_TEXT);
  await selectBasicAllYear(page, targetBasicAllYear);
  const selectedYearFromEnergyUsage = await detectSelectedYear(page);
  const energyUsageExtracted = await extractSingleSectionTableByHints(page, "用電紀錄", [
    "電費月份",
    "最高需量",
    "用電",
    "尖峰",
    "半尖峰",
    "離峰",
  ]);
  const energyUsageTables = aggregateEnergyUsageSections(energyUsageExtracted);

  await openBasicTab(page, PRICE_RECORD_TEXT);
  await selectBasicAllYear(page, targetBasicAllYear);
  const selectedYearFromPrice = await detectSelectedYear(page);
  const priceTables = await extractSingleSectionTableByHints(page, "電費紀錄", [
    "電費月份",
    "基本電費",
    "流動電費",
    "總額",
  ]);
  const selectedYear =
    targetBasicAllYear ||
    selectedYearFromEnergyUsage ||
    selectedYearFromPrice ||
    String(new Date().getFullYear());
  const artifactPath = writeArtifactJson(
    buildBasicAllArtifactPath(electricNumber, selectedYear),
    {
      basic: basicTables,
      energy_usage: energyUsageTables,
      price: priceTables,
    }
  );

  await refreshSavedState(context, page, "basic-all artifact save");
  return artifactPath;
}

async function savePowerAnalyzeMonthArtifact(page, context) {
  await ensurePowerAnalyzeFifteenMin(page);

  const targetMonth = parseTargetMonth();
  const electricNumber = await detectCurrentElectricNumber(page);
  const monthDates = listMonthDates(targetMonth.year, targetMonth.month);
  const daily = [];
  const artifactPathParts = buildPowerAnalyzeMonthArtifactPath(electricNumber, targetMonth);

  const writeMonthArtifact = async () => {
    const payload = {
      section: "需量分析",
      granularity: FIFTEEN_MIN_TEXT,
      target_month: {
        gregorian: `${targetMonth.year}/${String(targetMonth.month).padStart(2, "0")}`,
        roc: `${targetMonth.year - 1911}/${String(targetMonth.month).padStart(2, "0")}`,
      },
      page_url: page.url(),
      title: await page.title().catch(() => ""),
      daily,
    };

    return writeArtifactJson(artifactPathParts, payload);
  };

  for (const dateInfo of monthDates) {
    log(`Querying PowerAnalyze: ${dateInfo.slashDate}`);
    updateProgress("querying_month_day", `Querying PowerAnalyze for ${dateInfo.slashDate}.`, {
      current_date: dateInfo.slashDate,
    });
    try {
      const rendered = await runPowerAnalyzeQueryByDateWithTimeout(page, dateInfo);
      const chartData = rendered ? await collectCycleRawChartData(page) : [];
      const organizedSeries = rendered
        ? buildPowerAnalyzeSeriesData(chartData)
        : { series: [] };
      daily.push({
        target_date: {
          gregorian: dateInfo.slashDate,
          roc: dateInfo.rocDate,
        },
        series: organizedSeries.series,
      });
    } catch (error) {
      log(`PowerAnalyze query failed for ${dateInfo.slashDate}: ${error.message}`);
      daily.push({
        target_date: {
          gregorian: dateInfo.slashDate,
          roc: dateInfo.rocDate,
        },
        series: [],
      });
    }

    await writeMonthArtifact();
  }

  const artifactPath = await writeMonthArtifact();

  await refreshSavedState(context, page, "month artifact save");
  return artifactPath;
}

async function savePowerAnalyzeRangeArtifact(page, context, targetRangeOverride = null) {
  await ensurePowerAnalyzeFifteenMin(page);

  const targetRange = targetRangeOverride || parseTargetPowerAnalyzeRange();
  const electricNumber = await detectCurrentElectricNumber(page);
  const rangeDates = listDateRange(targetRange.start, targetRange.end);
  const daily = [];
  const artifactPathParts = buildPowerAnalyzeRangeArtifactPath(
    electricNumber,
    targetRange.start,
    targetRange.end
  );

  const writeRangeArtifact = async () => {
    const payload = {
      section: "需量分析",
      granularity: FIFTEEN_MIN_TEXT,
      target_range: {
        start_date: {
          gregorian: targetRange.start.slashDate,
          roc: targetRange.start.rocDate,
        },
        end_date: {
          gregorian: targetRange.end.slashDate,
          roc: targetRange.end.rocDate,
        },
      },
      page_url: page.url(),
      title: await page.title().catch(() => ""),
      daily,
    };

    return writeArtifactJson(artifactPathParts, payload);
  };

  for (const dateInfo of rangeDates) {
    log(`Querying PowerAnalyze: ${dateInfo.slashDate}`);
    updateProgress("querying_range_day", `Querying PowerAnalyze for ${dateInfo.slashDate}.`, {
      current_date: dateInfo.slashDate,
      range_start_date: targetRange.start.slashDate,
      range_end_date: targetRange.end.slashDate,
    });
    try {
      const rendered = await runPowerAnalyzeQueryByDateWithTimeout(page, dateInfo);
      const chartData = rendered ? await collectCycleRawChartData(page) : [];
      const organizedSeries = rendered
        ? buildPowerAnalyzeSeriesData(chartData)
        : { series: [] };
      daily.push({
        target_date: {
          gregorian: dateInfo.slashDate,
          roc: dateInfo.rocDate,
        },
        series: organizedSeries.series,
      });
    } catch (error) {
      log(`PowerAnalyze query failed for ${dateInfo.slashDate}: ${error.message}`);
      daily.push({
        target_date: {
          gregorian: dateInfo.slashDate,
          roc: dateInfo.rocDate,
        },
        series: [],
      });
    }

    await writeRangeArtifact();
  }

  const artifactPath = await writeRangeArtifact();

  await refreshSavedState(context, page, "range artifact save");
  return artifactPath;
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

function pickPowerAnalyzeFifteenChart(rawCharts) {
  const charts = Array.isArray(rawCharts) ? rawCharts.filter(Boolean) : [];
  if (!charts.length) return null;

  const byRenderTo = charts.filter((chart) =>
    normalizeText(chart?.renderTo || "").toLowerCase() === "fifteenminutechart"
  );
  if (byRenderTo.length) {
    return byRenderTo[byRenderTo.length - 1];
  }

  // Fallback: choose the chart with the largest x-axis categories.
  return charts.reduce((best, current) => {
    const bestCount = Array.isArray(best?.xAxisCategories) ? best.xAxisCategories.length : 0;
    const currentCount = Array.isArray(current?.xAxisCategories) ? current.xAxisCategories.length : 0;
    return currentCount >= bestCount ? current : best;
  }, null);
}

function buildPowerAnalyzeSeriesData(rawCharts) {
  const chart = pickPowerAnalyzeFifteenChart(rawCharts);
  if (!chart) {
    return { series: [] };
  }

  const xAxis = Array.isArray(chart.xAxisCategories)
    ? chart.xAxisCategories.map((item) => String(item))
    : [];

  const series = (Array.isArray(chart.series) ? chart.series : []).map((item) => {
    const values = normalizeChartValues(item.data || []);
    const alignedValues = xAxis.map((_, index) => values[index] ?? null);
    return {
      category: item.name || "",
      series_data: xAxis.map((time, index) => ({
        time,
        value: alignedValues[index],
      })),
    };
  });

  return {
    series,
  };
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

async function writeArtifacts(payload) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  if (payload.dashboardData) {
    fs.writeFileSync(CLEAN_OUTPUT_PATH, JSON.stringify(payload.dashboardData, null, 2));
  }
}

async function main() {
  updateProgress("starting", "Launching HVCS extraction flow.");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(buildContextOptions());

  try {
    const page = await context.newPage();
    const authenticatedPage = await ensureAuthenticated(context, page);
    updateProgress("navigating", "Authenticated. Navigating to target page.");
    const targetPage = await navigateToTarget(context, authenticatedPage);
    await refreshSavedState(context, targetPage, "target navigation");

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

      await writeArtifacts(payload);

      log(`Saved JSON: ${OUTPUT_PATH}`);
      return;
    }

    if (TARGET_PAGE === "price") {
      const payload = await extractSingleSectionTableByHints(targetPage, "電費紀錄", [
        "電費月份",
        "基本電費",
        "流動電費",
        "總額",
      ]);

      await writeArtifacts(payload);

      log(`Saved JSON: ${OUTPUT_PATH}`);
      return;
    }

    if (TARGET_PAGE === "power_analyze") {
      const rendered = await selectPowerAnalyzeYstdAndFifteenMin(targetPage);
      const targetDate = parseTargetPowerAnalyzeDate();
      const electricNumber = await detectCurrentElectricNumber(targetPage);
      const chartData = rendered ? await collectCycleRawChartData(targetPage) : [];
      const organizedSeries = rendered
        ? buildPowerAnalyzeSeriesData(chartData)
        : { series: [] };
      const payload = {
        section: "需量分析",
        granularity: FIFTEEN_MIN_TEXT,
        target_date: {
          gregorian: targetDate.slashDate,
          roc: targetDate.rocDate,
        },
        page_url: targetPage.url(),
        title: await targetPage.title().catch(() => ""),
        series: organizedSeries.series,
      };

      const artifactPath = writeArtifactJson(
        buildPowerAnalyzeDayArtifactPath(electricNumber, targetDate),
        payload
      );

      await refreshSavedState(context, targetPage, "day artifact save");
      updateProgress("completed", "Saved day artifact.", {
        artifact_path: artifactPath,
      });
      log(`Saved artifact JSON: ${artifactPath}`);
      return;
    }

    if (TARGET_PAGE === "power_analyze_month") {
      const artifactPath = await savePowerAnalyzeMonthArtifact(targetPage, context);
      updateProgress("completed", "Saved month artifact.", {
        artifact_path: artifactPath,
      });
      log(`Saved artifact JSON: ${artifactPath}`);
      return;
    }

    if (TARGET_PAGE === "power_analyze_range") {
      const artifactPath = await savePowerAnalyzeRangeArtifact(targetPage, context);
      updateProgress("completed", "Saved range artifact.", {
        artifact_path: artifactPath,
      });
      log(`Saved artifact JSON: ${artifactPath}`);
      return;
    }

    if (TARGET_PAGE === "basic") {
      const payload = await extractBasicSections(targetPage);

      await writeArtifacts(payload);

      log(`Saved JSON: ${OUTPUT_PATH}`);
      return;
    }

    if (TARGET_PAGE === "energy_usage") {
      const extracted = await extractSingleSectionTableByHints(targetPage, "用電紀錄", [
        "電費月份",
        "最高需量",
        "用電",
        "尖峰",
        "半尖峰",
        "離峰",
      ]);
      const payload = aggregateEnergyUsageSections(extracted);

      await writeArtifacts(payload);

      log(`Saved JSON: ${OUTPUT_PATH}`);
      return;
    }

    if (TARGET_PAGE === "all") {
      const basicAllJsonPath = await saveBasicAllArtifact(targetPage, context);
      updateProgress("completed", "Saved basic-all artifact.", {
        artifact_path: basicAllJsonPath,
      });
      log(`Saved artifact JSON: ${basicAllJsonPath}`);
      return;
    }

    if (TARGET_PAGE === "all_month") {
      const basicAllJsonPath = await saveBasicAllArtifact(targetPage, context);
      updateProgress(
        "combined_next",
        "Basic-all artifact saved. Continuing to monthly PowerAnalyze in the same session.",
        {
          basic_all_artifact_path: basicAllJsonPath,
        }
      );
      log(`Saved artifact JSON: ${basicAllJsonPath}`);

      await targetPage.goto(`https://service.taipower.com.tw${POWER_ANALYZE_PATH}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForPageSettled(targetPage);
      await refreshSavedState(context, targetPage, "power analyze month navigation");

      const powerMonthArtifactPath = await savePowerAnalyzeMonthArtifact(targetPage, context);
      updateProgress("completed", "Saved combined basic-all and month artifacts.", {
        basic_all_artifact_path: basicAllJsonPath,
        power_month_artifact_path: powerMonthArtifactPath,
      });
      log(`Saved artifact JSON: ${powerMonthArtifactPath}`);
      return;
    }

    if (TARGET_PAGE === "all_range") {
      const basicAllJsonPath = await saveBasicAllArtifact(targetPage, context);
      updateProgress(
        "combined_next",
        "Basic-all artifact saved. Continuing to exact-range PowerAnalyze in the same session.",
        {
          basic_all_artifact_path: basicAllJsonPath,
        }
      );
      log(`Saved artifact JSON: ${basicAllJsonPath}`);

      await targetPage.goto(`https://service.taipower.com.tw${POWER_ANALYZE_PATH}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForPageSettled(targetPage);
      await refreshSavedState(context, targetPage, "power analyze range navigation");

      const targetRange = resolveTargetPowerAnalyzeRangeFromBasicAll(basicAllJsonPath);
      log(`Resolved PowerAnalyze range from ${targetRange.source}: ${targetRange.start.slashDate} ~ ${targetRange.end.slashDate}`);
      updateProgress("range_resolved", "Resolved PowerAnalyze range from bill data.", {
        basic_all_artifact_path: basicAllJsonPath,
        source: targetRange.source,
        range_start_date: targetRange.start.slashDate,
        range_end_date: targetRange.end.slashDate,
        bill_month: targetRange.bill_month || null,
        bill_year: targetRange.bill_year || null,
        bill_months: targetRange.bill_months || null,
      });

      const powerRangeArtifactPath = await savePowerAnalyzeRangeArtifact(targetPage, context, targetRange);
      updateProgress("completed", "Saved combined basic-all and range artifacts.", {
        basic_all_artifact_path: basicAllJsonPath,
        power_range_artifact_path: powerRangeArtifactPath,
        source: targetRange.source,
      });
      log(`Saved artifact JSON: ${powerRangeArtifactPath}`);
      return;
    }

    const headings = await collectHeadings(targetPage);
    const definitionListPairs = await collectDefinitionLists(targetPage);
    const metricCandidates = dedupeMetrics(await collectMetricCandidates(targetPage));
    const tables = await collectTables(targetPage);
    const visibleText = await collectVisibleText(targetPage);
    const html = await targetPage.content();
    const dashboardData =
      TARGET_PAGE === "dashboard" ? extractDashboardDataFromHtml(html) : null;

    const payload = {
      extractedAt: new Date().toISOString(),
      source: {
        baseUrl: BASE_URL,
        pageUrl: targetPage.url(),
        electricNumber:
          dashboardData?.electric_number || (process.env.HVCS_ELECTRIC_NUMBER || "").trim() || null,
      },
      targetPage: TARGET_PAGE,
      ...(dashboardData ? { dashboardData } : {}),
      headings,
      keyValues: buildKeyValueObject(definitionListPairs),
      definitionListPairs,
      metrics: metricCandidates,
      tables,
      text: visibleText,
    };

    await writeArtifacts(payload);

    log(`Saved JSON: ${OUTPUT_PATH}`);
    if (dashboardData) {
      log(`Saved cleaned JSON: ${CLEAN_OUTPUT_PATH}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  updateProgress("failed", error.message);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
