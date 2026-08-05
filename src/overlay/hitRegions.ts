/**
 * Registry of opaque interaction areas published to the Rust passthrough poller.
 *
 * Any overlay surface that should swallow clicks — the context menu, and later
 * the chat panel and toasts — registers its element here. A single rAF loop
 * reads their boxes and pushes them over IPC, but only when something actually
 * moved, so an idle overlay costs nothing on the Rust side.
 *
 * The sprite is *not* registered here; it is hit-tested against an alpha mask
 * instead. See `src/lib/alphaMask.ts`.
 */

import { useEffect } from "react";
import { ipc, type Rect } from "@/lib/ipc";

const elements = new Map<string, HTMLElement>();

let frame = 0;
let lastPublished = "";

function collect(): Rect[] {
  const rects: Rect[] = [];
  for (const element of elements.values()) {
    const box = element.getBoundingClientRect();
    // A hidden or not-yet-laid-out element must not claim the cursor.
    if (box.width <= 0 || box.height <= 0) continue;
    rects.push({ x: box.x, y: box.y, width: box.width, height: box.height });
  }
  return rects;
}

function publish(rects: Rect[]): void {
  // Rounding to whole pixels keeps sub-pixel jitter from spamming IPC.
  const key = rects
    .map((r) =>
      [r.x, r.y, r.width, r.height].map((n) => Math.round(n)).join(","),
    )
    .join("|");

  if (key === lastPublished) return;
  lastPublished = key;
  void ipc.setHitRegions(rects);
}

function tick(): void {
  publish(collect());
  frame = elements.size > 0 ? requestAnimationFrame(tick) : 0;
  if (frame === 0) publish([]);
}

function ensureRunning(): void {
  if (frame === 0 && elements.size > 0) {
    frame = requestAnimationFrame(tick);
  }
}

export function registerHitRegion(id: string, element: HTMLElement): void {
  elements.set(id, element);
  ensureRunning();
}

export function unregisterHitRegion(id: string): void {
  elements.delete(id);
  if (elements.size === 0) {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    publish([]);
  }
}

/** Registers a ref'd element as an interaction area while `enabled` is true. */
export function useHitRegion(
  id: string,
  ref: React.RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    registerHitRegion(id, element);
    return () => unregisterHitRegion(id);
  }, [id, ref, enabled]);
}
