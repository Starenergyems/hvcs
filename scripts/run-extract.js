#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
const env = { ...process.env };

function readOption(name) {
  const prefix = name + "=";
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return null;
}

const target = readOption("--target");
const basicYear = readOption("--basic-year");
const startDate = readOption("--start");
const endDate = readOption("--end");
const billYear = readOption("--bill-year");
const billMonth = readOption("--bill-month");

if (target) env.HVCS_TARGET_PAGE = target;
if (basicYear) env.HVCS_BASIC_ALL_YEAR = basicYear;
if (billYear) {
  env.HVCS_BILL_YEAR = billYear;
  if (!basicYear) env.HVCS_BASIC_ALL_YEAR = billYear;
}
if (billMonth) env.HVCS_BILL_MONTH = billMonth;
if (startDate) env.HVCS_POWER_ANALYZE_START_DATE = startDate;
if (endDate) env.HVCS_POWER_ANALYZE_END_DATE = endDate;

const child = spawn(process.execPath, [path.join(__dirname, "extract-dashboard.js")], {
  cwd: path.resolve(__dirname, ".."),
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
