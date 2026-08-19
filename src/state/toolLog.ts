import { create } from "zustand";
import { readSetting, writeSetting } from "@/lib/persist";

/**
 * The ledger of what she has actually done.
 *
 * The whole security story is "she can only do the things in the catalog" —
 * this is the complement: here is every time she did one. Until this existed
 * the record lived only inside each chat message and evaporated with the
 * panel, so "did she touch my theme yesterday?" had no answer.
 *
 * What is stored is deliberately thin: when, the tool's user-facing label,
 * her plain-language summary, and whether it worked. Never the arguments and
 * never the raw result string — those are written for the model, and a
 * ledger that quotes them would slowly become a transcript archive, which is
 * exactly what the history setting promises this app does not keep.
 */
export interface ToolLogEntry {
  /** Unix milliseconds. */
  time: number;
  /** The catalog's user_label — what the settings switch also says. */
  label: string;
  /** Her own account of what happened, as shown in the transcript. */
  summary: string;
  /** False when the tool refused or failed. */
  ok: boolean;
}

/** Newest first, capped: a ledger, not an archive. */
const CAP = 100;

const STORAGE_KEY = "toolLog";

interface ToolLogStore {
  entries: ToolLogEntry[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  record: (entry: ToolLogEntry) => void;
  clear: () => void;
}

export const useToolLogStore = create<ToolLogStore>((set, get) => ({
  entries: [],
  hydrated: false,

  hydrate: async () => {
    const stored = await readSetting<ToolLogEntry[]>(STORAGE_KEY, []);
    set({
      entries: Array.isArray(stored) ? stored.slice(0, CAP) : [],
      hydrated: true,
    });
  },

  record: (entry) => {
    const entries = [entry, ...get().entries].slice(0, CAP);
    set({ entries });
    void writeSetting(STORAGE_KEY, entries);
  },

  clear: () => {
    set({ entries: [] });
    void writeSetting(STORAGE_KEY, []);
  },
}));
