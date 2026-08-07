/**
 * Builds the demo into one self-contained HTML file.
 *
 *   node scripts/build-demo.mjs [out.html]
 *
 * Everything is inlined because the page is published to a host with a strict
 * CSP that blocks every external request — no CDN, no separate asset fetches.
 *
 * The font needs care: the family ships as ~100 unicode-range subsets totalling
 * 6 MB, and base64 would make that 8 MB of HTML. So the page's own text is
 * scanned and only the subsets whose ranges it actually touches are embedded.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist-demo");
const outPath = resolve(process.argv[2] ?? join(root, "demo-standalone.html"));

const html = await readFile(join(dist, "demo.html"), "utf8");

/** Every codepoint the built page can render, from its CSS and JS. */
async function pageCodepoints(assets) {
  const points = new Set();
  for (const file of assets) {
    const content = await readFile(join(dist, "assets", file), "utf8");
    for (const ch of content) points.add(ch.codePointAt(0));
  }
  // ASCII always, so Latin UI text never falls back.
  for (let c = 0x20; c < 0x7f; c++) points.add(c);
  return points;
}

function rangeMatches(rangeText, points) {
  for (const part of rangeText.split(",")) {
    const token = part.trim().replace(/^U\+/i, "");
    if (!token) continue;

    if (token.includes("-")) {
      const [lo, hi] = token.split("-").map((h) => parseInt(h, 16));
      for (const point of points) if (point >= lo && point <= hi) return true;
    } else if (token.includes("?")) {
      const lo = parseInt(token.replace(/\?/g, "0"), 16);
      const hi = parseInt(token.replace(/\?/g, "F"), 16);
      for (const point of points) if (point >= lo && point <= hi) return true;
    } else {
      const value = parseInt(token, 16);
      if (points.has(value)) return true;
    }
  }
  return false;
}

// Collect the built assets referenced by the page.
const scripts = [...html.matchAll(/<script[^>]+src="\/assets\/([^"]+)"/g)].map((m) => m[1]);
const styles = [...html.matchAll(/<link[^>]+href="\/assets\/([^"]+\.css)"/g)].map((m) => m[1]);

const points = await pageCodepoints([...scripts, ...styles]);

let css = "";
let fontBytes = 0;
let kept = 0;
let dropped = 0;

for (const file of styles) {
  const content = await readFile(join(dist, "assets", file), "utf8");

  // Rewrite each @font-face in place and leave every other rule untouched.
  // Splitting the stylesheet on "@font-face" and keeping only the matches would
  // silently discard the application's own CSS, which lives before the first
  // rule and after the last one.
  const rules = [...content.matchAll(/@font-face\s*\{[^}]*\}/g)];
  let cursor = 0;

  for (const match of rules) {
    css += content.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    const block = match[0];
    const url = block.match(/url\(([^)]+?)\)/)?.[1]?.replace(/["']/g, "");
    // The trailing semicolon is optional: minified CSS drops the last one, so
    // the terminator has to accept `}` as well.
    const range = block.match(/unicode-range:\s*([^;}]+)[;}]/)?.[1];

    if (!url || !range) {
      // Not a subset rule we understand — keep it verbatim rather than lose it.
      css += block;
      continue;
    }

    if (!rangeMatches(range, points)) {
      dropped += 1;
      continue;
    }

    const asset = url.replace(/^.*\/assets\//, "");
    const bytes = await readFile(join(dist, "assets", asset));
    fontBytes += bytes.length;
    kept += 1;

    css += `@font-face{font-family:"Noto Serif SC";font-style:normal;font-weight:200 900;font-display:swap;src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2");unicode-range:${range.trim()};}`;
  }

  css += content.slice(cursor);
}

let js = "";
for (const file of scripts) {
  js += await readFile(join(dist, "assets", file), "utf8") + "\n";
}

/*
 * The character herself, inlined.
 *
 * Only the two smallest animations: the whole pack is 19MB, and base64 adds a
 * third on top, which would put the page past the host's 16MB ceiling. Two is
 * enough to show that a state change swaps the frame and that the registration
 * offsets keep her from jumping — which is the thing worth seeing.
 */
const SPRITES = [
  { state: "idle", file: "间歇绘制.gif" },
  { state: "penIdle", file: "得意.gif" },
];

const packDir = join(root, "assets", "packs", "little-remielle");
const packManifest = JSON.parse(await readFile(join(packDir, "pack.json"), "utf8"));
const sprites = {};
let spriteBytes = 0;

for (const { state, file } of SPRITES) {
  try {
    const bytes = await readFile(join(packDir, file));
    const animation = packManifest.animations.find((a) => a.file === file);
    spriteBytes += bytes.length;
    sprites[state] = {
      src: `data:image/gif;base64,${bytes.toString("base64")}`,
      offset: animation?.offset ?? { x: 0, y: 0 },
    };
  } catch {
    // Assets are optional in a checkout that has not fetched them; the demo
    // falls back to its placeholder figure.
  }
}

const out = `<title>蕾米埃尔 Desktop Agent — 交互演示</title>
<style>
html,body,#root{margin:0;padding:0;width:100%;height:100%;}
body{user-select:none;-webkit-user-select:none;}
${css}
</style>
<div id="root"></div>
<script>
window.__REMIELLE_SPRITES__ = ${JSON.stringify(sprites)};
window.__REMIELLE_FRAME__ = ${JSON.stringify(packManifest.frameSize)};
</script>
<script type="module">
${js}
</script>
`;

await writeFile(outPath, out);
console.log(
  `${outPath}\n  ${(out.length / 1e6).toFixed(2)} MB total` +
    `\n  font: ${kept} subsets kept (${(fontBytes / 1e6).toFixed(2)} MB), ${dropped} dropped` +
    `\n  sprites: ${Object.keys(sprites).length} inlined (${(spriteBytes / 1e6).toFixed(2)} MB)`,
);
