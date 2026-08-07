import { create } from "zustand";

import { ipc, type ProviderInfo } from "@/lib/ipc";
import { readSetting, writeSetting } from "@/lib/persist";
import type { PanelTheme } from "@/lib/theme";

const STORAGE_KEY = "ai.config";

/**
 * How she speaks. Not who she is.
 *
 * The first line used to be "你是蕾米埃尔·丹…", which made her identity part of an
 * editable text box — clear the box and a stock assistant answered while every
 * asset, label and window title still said Remielle. The identity now lives in
 * `IDENTITY` in `src-tauri/src/llm/mod.rs`, is prepended to whatever is here,
 * and cannot be edited away.
 *
 * What remains is voice and manner, which is exactly what someone tuning this
 * field wants to change. Emptying it now means "no extra instructions", not "no
 * character".
 */
export const DEFAULT_SYSTEM_PROMPT = `说话狡黠、带一点戏谑，语气从容，偶尔在句尾用「呢~」。
和人拉近距离，但始终保持恰到好处的距离感——你习惯留一点余地，不把话一次说满。
回答要给足信息，不要谄媚，不要在开头堆砌客套。出错时用玩笑带过，不要反复道歉。`;

/**
 * Everything about how requests are made. Persisted; the API key itself is not
 * here — it lives in the OS credential store and never enters this process's
 * JavaScript.
 */
/**
 * What happens to a conversation when the panel closes.
 *
 * Transcripts never leave the machine — they go to a store file under the app's
 * own data directory, next to the settings. This decides whether one is written
 * at all, and the user has to be able to see and change it, because "does this
 * thing keep what I type?" is not a question anyone should have to guess at.
 */
export type HistoryMode = "keep" | "discard";

export interface AiConfig {
  provider: string;
  model: string;
  /** Override for the provider default; required for `custom`. */
  baseUrl: string;
  temperature: number;
  systemPrompt: string;
  /** Whether to let the model use web search. */
  webSearch: boolean;
  historyMode: HistoryMode;
  /**
   * Catalog tools she is allowed to use. A tool not listed here is never even
   * described to the model, so it cannot be called — the switch removes the
   * capability rather than asking her not to use it.
   */
  tools: string[];
  /** Palette for the floating panel. `auto` follows the OS. */
  panelTheme: PanelTheme;
  /** Applications `open_app` may launch. Empty means it can open nothing. */
  appAllowlist: string[];
}

const DEFAULTS: AiConfig = {
  provider: "deepseek",
  model: "",
  baseUrl: "",
  temperature: 0.8,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  webSearch: false,
  historyMode: "keep",
  /*
   * Only the harmless one is on out of the box.
   *
   * `get_system_info` reads the clock and the locale, which she needs to answer
   * "what time is it there" and nothing else. Everything that changes the
   * machine, and `get_active_window` — which reads the title of whatever you
   * have open — start off. A companion that could rearrange your settings on
   * first launch because a model decided to is not a good first impression.
   */
  tools: ["get_system_info"],
  panelTheme: "auto",
  appAllowlist: [],
};

interface ConfigStore extends AiConfig {
  hydrated: boolean;
  providers: ProviderInfo[];
  /** Provider ids that have a key stored. Never the keys themselves. */
  configured: string[];

  hydrate: () => Promise<void>;
  refreshConfigured: () => Promise<void>;
  patch: (patch: Partial<AiConfig>) => void;
}

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

export const useConfigStore = create<ConfigStore>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,
  providers: [],
  configured: [],

  hydrate: async () => {
    const [stored, providers] = await Promise.all([
      readSetting<Partial<AiConfig>>(STORAGE_KEY, {}),
      ipc.listProviders().catch(() => [] as ProviderInfo[]),
    ]);

    set({
      provider: stored.provider ?? DEFAULTS.provider,
      model: stored.model ?? DEFAULTS.model,
      baseUrl: stored.baseUrl ?? DEFAULTS.baseUrl,
      temperature: clamp(stored.temperature ?? DEFAULTS.temperature, 0, 2),
      systemPrompt: stored.systemPrompt ?? DEFAULTS.systemPrompt,
      webSearch: stored.webSearch ?? DEFAULTS.webSearch,
      historyMode: stored.historyMode === "discard" ? "discard" : DEFAULTS.historyMode,
      tools: Array.isArray(stored.tools) ? stored.tools : DEFAULTS.tools,
      panelTheme:
        stored.panelTheme === "light" || stored.panelTheme === "dark"
          ? stored.panelTheme
          : DEFAULTS.panelTheme,
      appAllowlist: Array.isArray(stored.appAllowlist) ? stored.appAllowlist : [],
      providers,
      hydrated: true,
    });

    await get().refreshConfigured();
  },

  refreshConfigured: async () => {
    const { providers } = get();
    const checks = await Promise.all(
      providers.map(async (info) => ({
        id: info.id,
        // A provider that needs no key counts as ready.
        ok: info.requiresKey ? await ipc.hasKey(info.id).catch(() => false) : true,
      })),
    );
    set({ configured: checks.filter((c) => c.ok).map((c) => c.id) });
  },

  patch: (patch) => {
    set(patch);
    const {
      provider,
      model,
      baseUrl,
      temperature,
      systemPrompt,
      webSearch,
      historyMode,
      tools,
      appAllowlist,
      panelTheme,
    } = get();
    void writeSetting<AiConfig>(STORAGE_KEY, {
      provider,
      model,
      baseUrl,
      temperature,
      systemPrompt,
      webSearch,
      historyMode,
      tools,
      appAllowlist,
      panelTheme,
    });
  },
}));

/** The currently selected provider's metadata, if known. */
export function currentProvider(state: ConfigStore): ProviderInfo | undefined {
  return state.providers.find((p) => p.id === state.provider);
}

/** Whether the current provider is ready to send. */
export function isReady(state: ConfigStore): boolean {
  return state.configured.includes(state.provider) && state.model.trim().length > 0;
}

/**
 * Whether web search can actually happen right now.
 *
 * The toggle is meaningless if the provider has no search facility, and showing
 * an enabled switch that silently does nothing would be worse than hiding it.
 */
export function searchAvailable(state: ConfigStore): boolean {
  return currentProvider(state)?.nativeSearch ?? false;
}
