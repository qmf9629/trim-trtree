#!/usr/bin/env node
/**
 * 截图工具（本地视觉验收）
 * 用法:
 *   node tools/screenshot.js <url> <out.png> [width] [height] [waitMs] [--full]
 * 例:
 *   node tools/screenshot.js http://127.0.0.1:18080/ docs/screenshots/empty.png 1440 900
 *   node tools/screenshot.js http://127.0.0.1:18080/ docs/screenshots/result.png 1440 900 1500
 *
 * 浏览器默认放在项目 .tools/ms-playwright 内，不写系统目录。
 */
const path = require("path");
const fs = require("fs");

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, "..", ".tools", "ms-playwright");
}

const { chromium } = require("playwright");

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const url = args[0] || "http://127.0.0.1:18080/";
  const out = args[1] || "screenshot.png";
  const width = parseInt(args[2] || "1440", 10);
  const height = parseInt(args[3] || "900", 10);
  const waitMs = parseInt(args[4] || "1200", 10);
  const fullPage = flags.includes("--full");

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push("console.error: " + msg.text());
  });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  page.on("requestfailed", (req) => {
    if (!req.url().startsWith("data:")) errors.push("requestfailed: " + req.url() + " " + (req.failure() && req.failure().errorText));
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: out, fullPage });
  console.log("saved", out, `${width}x${height}`);
  if (errors.length) {
    console.log("---- page issues ----");
    for (const e of errors.slice(0, 20)) console.log(e);
  } else {
    console.log("no console/page errors");
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
