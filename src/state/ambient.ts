import { create } from "zustand";

import {
  ambientBlock,
  DEFAULT_AMBIENT,
  EMPTY_AMBIENT_STATE,
  localDay,
  muteToday,
  recordFired,
  rollDay,
  type AmbientBlock,
  type AmbientSettings,
  type AmbientState,
} from "@/lib/ambient";
import { readSetting, writeSetting } from "@/lib/persist";

const SETTINGS_KEY = "ambient";
const STATE_KEY = "ambientState";

/**
 * How long she has to be left alone before dozing off.
 *
 * Independent of the activity schedule: this one is about *your* absence, not
 * her initiative, so it is not subject to quiet hours or the daily cap. Waking
 * is free and instant, so the cost of getting the threshold slightly wrong is
 * nothing.
 */
export const SLEEP_AFTER_MS = 12 * 60_000;

interface AmbientStore {
  hydrated: boolean;
  settings: AmbientSettings;
  /** Counter and mute flag. Persisted so a restart cannot reset the cap. */
  runtime: AmbientState;

  /** Narration currently on screen, if any. */
  narration: string | null;
  /** Whether she has dozed off. */
  asleep: boolean;

  hydrate: () => Promise<void>;
  patch: (patch: Partial<AmbientSettings>) => void;
  blockedBy: () => AmbientBlock;
  /** Records an activity against today's cap. */
  noteFired: () => void;
  /** "今天别再打扰我" */
  muteForToday: () => void;
  say: (text: string | null) => void;
  setAsleep: (asleep: boolean) => void;
}

export const useAmbientStore = create<AmbientStore>((set, get) => ({
  hydrated: false,
  settings: DEFAULT_AMBIENT,
  runtime: EMPTY_AMBIENT_STATE,
  narration: null,
  asleep: false,

  hydrate: async () => {
    const [settings, runtime] = await Promise.all([
      readSetting<Partial<AmbientSettings>>(SETTINGS_KEY, {}),
      readSetting<AmbientState>(STATE_KEY, EMPTY_AMBIENT_STATE),
    ]);

    set({
      settings: { ...DEFAULT_AMBIENT, ...settings },
      // Rolled on load: the app is routinely closed overnight, and a counter
      // restored from yesterday would silence her for the whole of today.
      runtime: rollDay({ ...EMPTY_AMBIENT_STATE, ...runtime }, new Date()),
      hydrated: true,
    });
  },

  patch: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void writeSetting(SETTINGS_KEY, settings);
  },

  blockedBy: () => ambientBlock(get().runtime, get().settings, new Date()),

  noteFired: () => {
    const runtime = recordFired(get().runtime, new Date());
    set({ runtime });
    void writeSetting(STATE_KEY, runtime);
  },

  muteForToday: () => {
    const runtime = muteToday(get().runtime, new Date());
    set({ runtime, narration: null });
    void writeSetting(STATE_KEY, runtime);
  },

  say: (narration) => set({ narration }),

  setAsleep: (asleep) => set({ asleep }),
}));

/** Whether the mute is for today rather than a stale one from a past day. */
export function isMutedToday(state: AmbientState, now = new Date()): boolean {
  return state.mutedDay === localDay(now);
}
