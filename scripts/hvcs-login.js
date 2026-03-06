const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

const LOGIN_URL = "https://service.taipower.com.tw/hvcs/";
const LOGIN_PATH_FRAGMENT = "/Account/NewLogon";
const AUTH_DIR = path.resolve(__dirname, "..", ".auth");
const USER_DATA_DIR = path.join(AUTH_DIR, "browser-profile");
const STORAGE_STATE_PATH = path.join(AUTH_DIR, "storage-state.json");

const CANDIDATE_SUCCESS_TEXT = ["登出", "登    出", "會員專區", "用電資料查詢"];

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

  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return false;
  if (!(await locator.isVisible().catch(() => false))) return false;

  await locator.fill(value);
  return true;
}

async function pageLooksAuthenticated(page) {
  const currentUrl = page.url();
  if (!currentUrl.includes(LOGIN_PATH_FRAGMENT)) {
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

async function saveState(context, page) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await page.waitForLoadState("networkidle").catch(() => {});
  await context.storageState({ path: STORAGE_STATE_PATH });
}

async function main() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 960 },
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  log("Taipower HVCS login page opened.");
  log(`Persistent browser profile: ${USER_DATA_DIR}`);
  log(`Storage state output: ${STORAGE_STATE_PATH}`);

  const accountFilled = await fillIfVisible(
    page,
    'input[placeholder*="帳號"], input[name*="Account"], input[id*="Account"], input[type="text"]',
    process.env.HVCS_ACCOUNT
  );

  const passwordFilled = await fillIfVisible(
    page,
    'input[placeholder*="密碼"], input[name*="Password"], input[id*="Password"], input[type="password"]',
    process.env.HVCS_PASSWORD
  );

  if (accountFilled || passwordFilled) {
    log("Filled credentials from environment variables where possible.");
  }

  log("Complete the remaining login steps in the browser.");
  log("This site shows a captcha on the login page, so a human needs to finish authentication.");
  log("Press Enter here after you see the logged-in page.");
  await waitForEnter("> ");

  if (!(await pageLooksAuthenticated(page))) {
    log("Authentication was not detected yet.");
    log("If the site opened a new tab or needs another redirect, finish that flow first and press Enter again.");
    await waitForEnter("> ");
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
