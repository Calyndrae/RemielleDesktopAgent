/** Typed wrappers over the Rust commands. Mirrors `src-tauri/src/`. */

import { invoke } from "@tauri-apps/api/core";
import type { PackManifest } from "@/types/pack";

export interface OverlayGeometry {
  /** Work-area size in logical pixels — the overlay's CSS viewport. */
  width: number;
  height: number;
  scaleFactor: number;
  monitor: string | null;
}

/** Logical-pixel rectangle relative to the overlay's client area. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteMask {
  rect: Rect;
  cols: number;
  rows: number;
  /** Row-major, one bit per cell, LSB first. */
  bits: number[];
}

export const ipc = {
  /** Places the overlay over the work area and reveals it. */
  overlayReady: () => invoke<OverlayGeometry>("overlay_ready"),

  /** Re-places the overlay after a display change. */
  refreshOverlayGeometry: () => invoke<OverlayGeometry>("refresh_overlay_geometry"),

  /** Opaque interaction areas: chat panel, context menu, toasts. */
  setHitRegions: (regions: Rect[]) => invoke<void>("set_hit_regions", { regions }),

  /** The sprite's position plus the alpha mask of its current frame. */
  setSpriteMask: (mask: SpriteMask | null) => invoke<void>("set_sprite_mask", { mask }),

  /** Pins the overlay interactive for the duration of a drag. */
  setForceInteractive: (enabled: boolean) =>
    invoke<void>("set_force_interactive", { enabled }),

  loadPack: (id: string) => invoke<PackManifest>("load_pack", { id }),
  listPacks: () => invoke<PackManifest[]>("list_packs"),

  quitApp: () => invoke<void>("quit_app"),
};
