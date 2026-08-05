/**
 * Builds the coarse alpha mask the Rust passthrough poller hit-tests against.
 *
 * The sprite is a character on a transparent canvas, so its bounding box is
 * mostly empty. Blocking desktop clicks in those corners feels broken, but the
 * webview can't own the alpha test either — see the module docs in
 * `src-tauri/src/window/passthrough.rs`. So the current frame gets downscaled
 * to a small grid here and shipped over IPC.
 */

/**
 * Mask resolution. At 48x48 over a ~300px sprite each cell is ~6 logical
 * pixels, which is finer than a user can aim and keeps the payload at 288
 * bytes. Pixel-exact hit testing on a hair strand would be worse, not better.
 */
export const MASK_COLS = 48;
export const MASK_ROWS = 48;

/**
 * Alpha at or below this counts as transparent (0-255).
 *
 * Downscaling averages alpha, so an edge cell that is 10% covered comes back
 * with a low value. A low threshold keeps soft edges clickable.
 */
const ALPHA_THRESHOLD = 24;

let canvas: HTMLCanvasElement | null = null;
let context: CanvasRenderingContext2D | null = null;

function getContext(): CanvasRenderingContext2D | null {
  if (context) return context;
  canvas ??= document.createElement("canvas");
  canvas.width = MASK_COLS;
  canvas.height = MASK_ROWS;
  // `willReadFrequently` keeps the surface in software memory, which is what we
  // want for a getImageData every frame or two.
  context = canvas.getContext("2d", { willReadFrequently: true });
  return context;
}

/**
 * Renders `source` into the mask grid and packs the result into bits.
 *
 * Returns `null` when the mask can't be produced — an unloaded image, or a
 * canvas tainted by the `asset:` protocol not sending permissive CORS headers.
 * Callers should fall back to a plain rectangle so the sprite stays clickable.
 */
export function buildAlphaMask(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): number[] | null {
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const ctx = getContext();
  if (!ctx) return null;

  ctx.clearRect(0, 0, MASK_COLS, MASK_ROWS);
  try {
    ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, MASK_COLS, MASK_ROWS);
  } catch {
    // Image not decodable yet (zero-sized, broken src).
    return null;
  }

  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, MASK_COLS, MASK_ROWS).data;
  } catch {
    // SecurityError: the canvas is tainted. Nothing to recover here.
    return null;
  }

  const bits = new Array<number>(Math.ceil((MASK_COLS * MASK_ROWS) / 8)).fill(0);
  for (let index = 0; index < MASK_COLS * MASK_ROWS; index++) {
    const alpha = pixels[index * 4 + 3] ?? 0;
    if (alpha > ALPHA_THRESHOLD) {
      bits[index >> 3]! |= 1 << (index & 7);
    }
  }
  return bits;
}

/** A mask covering the whole box, used when the alpha test is unavailable. */
export function solidMask(): number[] {
  return new Array<number>(Math.ceil((MASK_COLS * MASK_ROWS) / 8)).fill(0xff);
}
