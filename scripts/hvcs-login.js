const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

const ENV_PATH = path.resolve(__dirname, "..", ".env");
const LOGIN_URL = "https://service.taipower.com.tw/hvcs/";
const LOGIN_PATH_FRAGMENT = "/Account/NewLogon";
const AUTH_DIR = path.resolve(__dirname, "..", ".auth");
const USER_DATA_DIR = path.join(AUTH_DIR, "browser-profile");
const STORAGE_STATE_PATH = path.join(AUTH_DIR, "storage-state.json");
const AUTH_TIMEOUT_MS = Number(process.env.HVCS_AUTH_TIMEOUT_MS || 180000);

const CANDIDATE_SUCCESS_TEXT = ["登出", "登    出", "會員專區", "用電資料查詢"];
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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
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

async function waitForPageSettled(page, extraWaitMs = 900) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  if (extraWaitMs > 0) {
    await page.waitForTimeout(extraWaitMs);
  }
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

async function getActivePage(context, fallbackPage) {
  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  const page = pages[pages.length - 1] || fallbackPage;

  if (!page) {
    throw new Error("No browser page is available.");
  }

  await waitForPageSettled(page, 500);
  return page;
}

async function pageLooksAuthenticated(page) {
  const currentUrl = page.url();
  if (!currentUrl.includes(LOGIN_PATH_FRAGMENT)) {
    for (const text of CANDIDATE_SUCCESS_TEXT) {
      const match = page.getByText(text, { exact: false }).first();
      if ((await match.count()) > 0 && (await match.isVisible().catch(() => false))) {
        return true;
      }
    }

    const loginField = page.locator(PASSWORD_SELECTOR).first();
    return !(await loginField.isVisible().catch(() => false));
  }

  for (const text of CANDIDATE_SUCCESS_TEXT) {
    const match = page.getByText(text, { exact: false }).first();
    if ((await match.count()) > 0 && (await match.isVisible().catch(() => false))) {
      return true;
    }
  }

  return false;
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

async function saveState(context, page) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await waitForPageSettled(page);
  await context.storageState({ path: STORAGE_STATE_PATH });
}

async function main() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 960 },
  });

  let page = context.pages()[0] || (await context.newPage());
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await waitForPageSettled(page);

  log("Taipower HVCS login page opened.");
  log(`Persistent browser profile: ${USER_DATA_DIR}`);
  log(`Storage state output: ${STORAGE_STATE_PATH}`);

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
  log("This site shows a captcha on the login page, so a human needs to finish authentication.");
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
    throw new Error(
      "Still on the login page. Login state was not saved. Confirm the captcha/login succeeded and rerun."
    );
  }

  await saveState(context, page);

  log("Authentication detected and saved.");
  log("You can reuse the browser profile or the Playwright storage state in later scripts.");
  await context.close();
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
