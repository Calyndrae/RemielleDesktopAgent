import { create } from "zustand";
import { readSetting, writeSetting } from "@/lib/persist";

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 2.0;

/**
 * Persisted sprite placement.
 *
 * The anchor is stored as a *fraction* of the work area rather than in pixels
 * so the character lands in the same visual spot after a resolution change or
 * when the display it was on disappears.
 */
interface PersistedPlacement {
  anchorX: number;
  anchorY: number;
  scale: number;
  pinned: boolean;
  alwaysOnTop: boolean;
  monitor: string | null;
}

const DEFAULTS: PersistedPlacement = {
  // Lower right, clear of the taskbar clock and most desktop icons.
  anchorX: 0.86,
  anchorY: 0.78,
  scale: 1,
  pinned: false,
  alwaysOnTop: true,
  monitor: null,
};

const STORAGE_KEY = "sprite.placement";

interface SpriteStore extends PersistedPlacement {
  /** False until the persisted placement has been read back. */
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setAnchor: (x: number, y: number) => void;
  setScale: (scale: number) => void;
  nudgeScale: (delta: number) => void;
  setPinned: (pinned: boolean) => void;
  setAlwaysOnTop: (value: boolean) => void;
  setMonitor: (monitor: string | null) => void;
}

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

function persist(state: SpriteStore): void {
  const placement: PersistedPlacement = {
    anchorX: state.anchorX,
    anchorY: state.anchorY,
    scale: state.scale,
    pinned: state.pinned,
    alwaysOnTop: state.alwaysOnTop,
    monitor: state.monitor,
  };
  void writeSetting(STORAGE_KEY, placement);
}

export const useSpriteStore = create<SpriteStore>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,

  hydrate: async () => {
    const stored = await readSetting<Partial<PersistedPlacement>>(STORAGE_KEY, {});
    set({
      // Clamp on the way in: a hand-edited or older store must not put the
      // character off-screen or at an unusable size.
      anchorX: clamp(stored.anchorX ?? DEFAULTS.anchorX, 0, 1),
      anchorY: clamp(stored.anchorY ?? DEFAULTS.anchorY, 0, 1),
      scale: clamp(stored.scale ?? DEFAULTS.scale, MIN_SCALE, MAX_SCALE),
      pinned: stored.pinned ?? DEFAULTS.pinned,
      alwaysOnTop: stored.alwaysOnTop ?? DEFAULTS.alwaysOnTop,
      monitor: stored.monitor ?? DEFAULTS.monitor,
      hydrated: true,
    });
  },

  setAnchor: (x, y) => {
    set({ anchorX: clamp(x, 0, 1), anchorY: clamp(y, 0, 1) });
    persist(get());
  },

  setScale: (scale) => {
    set({ scale: clamp(scale, MIN_SCALE, MAX_SCALE) });
    persist(get());
  },

  nudgeScale: (delta) => {
    set({ scale: clamp(get().scale + delta, MIN_SCALE, MAX_SCALE) });
    persist(get());
  },

  setPinned: (pinned) => {
    set({ pinned });
    persist(get());
  },

  setAlwaysOnTop: (alwaysOnTop) => {
    set({ alwaysOnTop });
    persist(get());
  },

  setMonitor: (monitor) => {
    set({ monitor });
    persist(get());
  },
}));
