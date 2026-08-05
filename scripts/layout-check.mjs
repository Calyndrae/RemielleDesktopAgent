/**
 * Layout regression check for the chat panel.
 *
 * Serves the harness page, loads it in Chromium, and asserts the panel survives
 * content designed to break flex layouts: unbroken 70-character tokens, long
 * URLs, wide code lines, emoji runs, mixed CJK and Latin.
 *
 * The rule being enforced is that *text surfaces* never overflow their box,
 * while code blocks are allowed to — they are supposed to scroll internally
 * rather than widen the panel.
 *
 *   node scripts/layout-check.mjs [--headed] [--shot out.png]
 */

import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const args = process.argv.slice(2);
const shotIndex = args.indexOf("--shot");
const shotPath = shotIndex >= 0 ? args[shotIndex + 1] : null;

const VIEWPORT = { width: 1920, height: 1080 };
/** Sub-pixel rounding makes exact comparisons flaky. */
const TOLERANCE = 1;

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  server: { port: 5199, strictPort: true },
  logLevel: "warn",
});
await server.listen();

/**
 * Locate a Chromium to drive.
 *
 * The playwright package pins an exact browser build, which often will not be
 * the one an image already ships. Rather than downloading a second copy, fall
 * back to whatever full Chromium is present — this check only needs a renderer,
 * not a specific revision.
 */
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;

  const candidate = readdirSync(base)
    .filter((entry) => entry.startsWith("chromium-"))
    .map((entry) => join(base, entry, "chrome-linux", "chrome"))
    .find((path) => existsSync(path));

  return candidate;
}

const browser = await chromium.launch({
  headless: !args.includes("--headed"),
  executablePath: findChromium(),
});

try {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // The browser always asks for /favicon.ico; the harness has no icon and the
    // real app is a Tauri window, so a 404 here says nothing about the panel.
    if (m.location()?.url?.includes("favicon")) return;
    consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("requestfailed", (request) =>
    consoleErrors.push(`request failed: ${request.url()}`),
  );

  await page.goto("http://localhost:5199/harness.html", { waitUntil: "networkidle" });
  await page.waitForSelector(".panel", { timeout: 10_000 });
  // Let the entrance animation and chunk fades settle.
  await page.waitForTimeout(600);

  const report = await page.evaluate((tolerance) => {
    const overflowing = (element) =>
      element.scrollWidth - element.clientWidth > tolerance;

    const panel = document.querySelector(".panel");
    const scroll = document.querySelector(".panel__scroll");
    const composer = document.querySelector(".composer");
    const input = document.querySelector(".composer__input");

    const textSurfaces = [
      ...document.querySelectorAll(".msg__bubble, .prose, .para, .panel__header"),
    ];

    return {
      pageOverflows:
        document.documentElement.scrollWidth - document.documentElement.clientWidth >
        tolerance,
      panelFound: Boolean(panel),
      panelOverflows: panel ? overflowing(panel) : false,
      panelRect: panel ? panel.getBoundingClientRect().toJSON() : null,
      scrollOverflowsHorizontally: scroll ? overflowing(scroll) : false,
      // The composer must stay pinned; if the scroll area failed to shrink it
      // gets pushed out of the panel entirely.
      composerInsidePanel:
        panel && composer
          ? composer.getBoundingClientRect().bottom <=
            panel.getBoundingClientRect().bottom + tolerance
          : false,
      composerVisible: composer ? composer.getBoundingClientRect().height > 0 : false,
      inputCapped: input ? input.clientHeight <= 132 + tolerance : false,
      overflowingText: textSurfaces
        .filter(overflowing)
        .map((el) => `${el.className}: ${el.scrollWidth} > ${el.clientWidth}`),
      // Presence check: the stress content includes a fence, so a code block
      // must exist and must be the thing that scrolls.
      codeBlocks: [...document.querySelectorAll(".code")].map((el) => ({
        scrolls: el.scrollWidth - el.clientWidth > tolerance,
      })),
    };
  }, TOLERANCE);

  check(report.panelFound, "panel did not render");
  check(!report.pageOverflows, "page scrolls horizontally");
  check(!report.panelOverflows, "panel itself overflows horizontally");
  check(!report.scrollOverflowsHorizontally, "message area overflows horizontally");
  check(report.composerVisible, "composer has no height");
  check(report.composerInsidePanel, "composer was pushed outside the panel");
  check(report.inputCapped, "textarea grew past its cap instead of scrolling");
  check(
    report.overflowingText.length === 0,
    `text surfaces overflow: ${report.overflowingText.join("; ")}`,
  );
  check(report.codeBlocks.length > 0, "expected a code block in the stress content");
  check(
    report.codeBlocks.some((block) => block.scrolls),
    "code block did not scroll internally (long line may have widened the panel)",
  );
  check(
    consoleErrors.length === 0,
    `console errors: ${consoleErrors.slice(0, 3).join(" | ")}`,
  );

  if (shotPath) {
    await page.screenshot({ path: shotPath });
    console.log(`screenshot: ${shotPath}`);
  }

  console.log(
    `panel ${report.panelRect ? `${Math.round(report.panelRect.width)}x${Math.round(report.panelRect.height)}` : "?"}, ` +
      `${report.codeBlocks.length} code block(s)`,
  );
} finally {
  await browser.close();
  await server.close();
}

if (failures.length > 0) {
  console.error("\nLayout check FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Layout check passed.");
