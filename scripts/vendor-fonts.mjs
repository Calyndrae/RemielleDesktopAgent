/**
 * Vendors Noto Serif SC into the repository.
 *
 *   node scripts/vendor-fonts.mjs
 *
 * The app must render correctly with no network — it is a desktop companion,
 * not a web page — and the Artifact/webview CSP blocks external hosts anyway.
 * So the font is downloaded once and committed rather than linked from a CDN.
 *
 * Google serves the family split into ~100 `unicode-range` subsets. That split
 * is kept: the browser only loads the ranges a given conversation actually
 * touches, so a chat in Latin never pays for the CJK tables even though every
 * subset is present on disk.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = join(root, "src/assets/fonts");

const FAMILY = "Noto Serif SC";
/**
 * The whole weight axis, as a range.
 *
 * Noto Serif SC is a variable font: one file per subset covers every weight.
 * Requesting discrete weights (`wght@400;600`) makes Google emit two rules
 * pointing at the *same* file, which the browser renders at the file's default
 * instance and then fake-bolds — so 600 would look like smeared 400. Asking for
 * the range emits one rule per subset with a `font-weight` range, and the
 * browser instances the axis properly.
 */
const WEIGHT_AXIS = "200..900";
const WEIGHT_RANGE = "200 900";

// A modern desktop UA is what makes Google return woff2 + unicode-range subsets
// rather than a single legacy blob.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const cssUrl =
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(FAMILY).replace(/%20/g, "+")}` +
  `:wght@${WEIGHT_AXIS}&display=swap`;

console.log(`fetching ${cssUrl}`);
const css = await fetch(cssUrl, { headers: { "User-Agent": UA } }).then((r) => {
  if (!r.ok) throw new Error(`font CSS request failed: ${r.status}`);
  return r.text();
});

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const blocks = css.split("@font-face").slice(1);
console.log(`${blocks.length} subsets`);

const seen = new Map();
let out = `/*
 * ${FAMILY} — vendored, do not edit by hand.
 * Regenerate with: node scripts/vendor-fonts.mjs
 * Licensed under the SIL Open Font License 1.1 — see OFL.txt in this directory.
 */\n\n`;
let total = 0;

for (const block of blocks) {
  const url = block.match(/url\((https:\/\/[^)]+)\)/)?.[1];
  const range = block.match(/unicode-range:\s*([^;]+);/)?.[1];
  if (!url || !range) continue;

  let file = seen.get(url);
  if (!file) {
    // A sequential counter, not the index embedded in the URL: those indices
    // are not unique across the whole family, and reusing them silently
    // overwrote four subsets — leaving rules pointing at the wrong glyphs.
    file = `noto-serif-sc-${String(seen.size).padStart(3, "0")}.woff2`;
    const bytes = Buffer.from(
      await fetch(url, { headers: { "User-Agent": UA } }).then((r) => {
        if (!r.ok) throw new Error(`subset ${url} failed: ${r.status}`);
        return r.arrayBuffer();
      }),
    );
    await writeFile(join(outDir, file), bytes);
    total += bytes.length;
    seen.set(url, file);
  }

  out += `@font-face {
  font-family: "${FAMILY}";
  font-style: normal;
  font-weight: ${WEIGHT_RANGE};
  font-display: swap;
  src: url("./${file}") format("woff2");
  unicode-range: ${range.trim()};
}\n\n`;
}

await writeFile(join(outDir, "noto-serif-sc.css"), out);

const license = await fetch(
  "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/LICENSE",
)
  .then((r) => (r.ok ? r.text() : null))
  .catch(() => null);
if (license) await writeFile(join(outDir, "OFL.txt"), license);

console.log(
  `wrote ${seen.size} files, ${(total / 1e6).toFixed(2)} MB, license ${license ? "ok" : "MISSING — add manually"}`,
);
