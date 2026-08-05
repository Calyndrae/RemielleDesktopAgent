/**
 * Captures the overlay's UI states as PNGs from the harness page.
 *
 *   node scripts/ui-preview.mjs [outDir]
 *
 * Shots are cropped to the surface being previewed rather than the whole
 * viewport, except the flight stills, which need the surrounding space to show
 * the arc.
 */

import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(process.argv[2] ?? join(root, "preview"));
mkdirSync(outDir, { recursive: true });

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;
  return readdirSync(base)
    .filter((entry) => entry.startsWith("chromium-"))
    .map((entry) => join(base, entry, "chrome-linux", "chrome"))
    .find((path) => existsSync(path));
}

/** `clip` is a viewport region; `selector` crops to an element with padding. */
const SHOTS = [
  { name: "01-conversation", query: "scene=conversation", selector: ".panel", top: true },
  { name: "02-streaming", query: "scene=streaming", selector: ".panel" },
  { name: "03-empty", query: "scene=empty", selector: ".panel" },
  { name: "04-composer-limit", query: "scene=composer", selector: ".panel" },
  { name: "05-stress", query: "scene=stress", selector: ".panel" },
  { name: "06-context-menu", query: "scene=menu", full: true },
  { name: "07-fault", query: "scene=fault", selector: ".fault" },
  { name: "08-flight-t20", query: "scene=flight&t=0.2", full: true },
  { name: "09-flight-t50", query: "scene=flight&t=0.5", full: true },
  { name: "10-flight-t80", query: "scene=flight&t=0.8", full: true },
];

const PAD = 28;

const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  server: { port: 5200, strictPort: true },
  logLevel: "warn",
});
await server.listen();

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });

try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    // Enough oversampling to stay crisp on a high-DPI display without turning
    // a ten-shot set into tens of megabytes.
    deviceScaleFactor: Number(process.env.PREVIEW_SCALE ?? 1.5),
  });

  for (const shot of SHOTS) {
    await page.goto(`http://localhost:5200/harness.html?${shot.query}`, {
      waitUntil: "networkidle",
    });
    await page.waitForTimeout(700);

    // Done after the wait, not during mount: the panel sticks itself to the
    // bottom as content arrives, and fonts settling afterwards changes
    // scrollHeight again. Forcing it here is the only reliable point.
    if (shot.top) {
      await page.evaluate(() => {
        const scroller = document.querySelector(".panel__scroll");
        if (scroller) scroller.scrollTop = 0;
      });
      await page.waitForTimeout(120);
    }

    const path = join(outDir, `${shot.name}.png`);

    if (shot.full) {
      // Crop to the interesting half of the screen: panel through character.
      await page.screenshot({ path, clip: { x: 880, y: 250, width: 800, height: 620 } });
    } else {
      const box = await page.locator(shot.selector).boundingBox();
      if (!box) throw new Error(`${shot.name}: ${shot.selector} not found`);
      await page.screenshot({
        path,
        clip: {
          x: Math.max(0, box.x - PAD),
          y: Math.max(0, box.y - PAD),
          width: box.width + PAD * 2,
          height: box.height + PAD * 2,
        },
      });
    }

    console.log(`  ${shot.name}.png`);
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\nWrote ${SHOTS.length} previews to ${outDir}`);
