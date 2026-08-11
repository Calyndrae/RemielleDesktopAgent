import { create } from "zustand";

import { ipc, type ProviderInfo } from "@/lib/ipc";
import { readSetting, writeSetting } from "@/lib/persist";
import type { PanelTheme } from "@/lib/theme";
import { EMPTY_PROFILE, type UserProfile } from "@/lib/profile";

const STORAGE_KEY = "ai.config";

/**
 * Credential-store account for the web-search key. Mirrors `KEY_ACCOUNT` in
 * `src-tauri/src/search/mod.rs`; the two must agree or the key is stored under
 * a name nothing reads.
 */
export const SEARCH_ACCOUNT = "search";

/**
 * Extra instructions only. Who she is AND how she speaks both live in
 * `src-tauri/src/llm/mod.rs` (`IDENTITY`, `VOICE`) and cannot be edited away.
 *
 * The voice used to be this field's default text, which made "clear the box"
 * mean "remove her manner" — and a user met a Remielle who knew her own name
 * but answered like a stock assistant. Identity without voice is a nametag.
 * Now an empty field is the normal state and means "nothing extra".
 */
export const DEFAULT_SYSTEM_PROMPT = "";

/**
 * The voice text as it shipped while it was still this field's default.
 * A stored copy of it means the user never customized anything — migrating
 * it to empty avoids telling her how to speak twice. Kept verbatim,
 * including the trailing period style; the comparison is exact.
 */
const LEGACY_VOICE_DEFAULT = `说话狡黠、带一点戏谑，语气从容，偶尔在句尾用「呢~」。
和人拉近距离，但始终保持恰到好处的距离感——你习惯留一点余地，不把话一次说满。
回答要给足信息，不要谄媚，不要在开头堆砌客套。出错时用玩笑带过，不要反复道歉。`;

/** Reads a stored prompt, translating the legacy voice default to "none". */
export function migrateSystemPrompt(stored: string | undefined): string {
  if (stored === undefined) return DEFAULT_SYSTEM_PROMPT;
  return stored.trim() === LEGACY_VOICE_DEFAULT.trim() ? "" : stored;
}

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
  /**
   * The Programmable Search engine id (`cx`).
   *
   * Public, not secret — it names which search engine to query, not who is
   * asking. The key that authorises the request lives in the OS credential
   * store like every other key and never enters this file.
   */
  searchEngineId: string;
  /** The "about you" block, per-field opt-in. See lib/profile.ts. */
  profile: UserProfile;
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
  searchEngineId: "",
  profile: EMPTY_PROFILE,
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
      systemPrompt: migrateSystemPrompt(stored.systemPrompt),
      webSearch: stored.webSearch ?? DEFAULTS.webSearch,
      historyMode: stored.historyMode === "discard" ? "discard" : DEFAULTS.historyMode,
      tools: Array.isArray(stored.tools) ? stored.tools : DEFAULTS.tools,
      panelTheme:
        stored.panelTheme === "light" || stored.panelTheme === "dark"
          ? stored.panelTheme
          : DEFAULTS.panelTheme,
      appAllowlist: Array.isArray(stored.appAllowlist) ? stored.appAllowlist : [],
      searchEngineId: stored.searchEngineId ?? DEFAULTS.searchEngineId,
      profile: { ...EMPTY_PROFILE, ...(stored.profile ?? {}) },
      providers,
      hydrated: true,
    });

    /*
     * Deliberately NOT awaited, and the reason is a photograph: has_key hits
     * the macOS Keychain, and when the app's code signature changes (every
     * ad-hoc rebuild, every update) the Keychain raises a password prompt per
     * stored item. Awaiting this meant the entire boot — placement, show,
     * everything — sat frozen behind a modal until the user typed a password.
     * She appears first; the "configured" ticks arrive whenever the Keychain
     * answers, and the UI reads as unconfigured in the meantime, which is
     * true.
     */
    void get().refreshConfigured();

    /*
     * Warm the current provider's key, off the critical path.
     *
     * If a Keychain approval is owed, this is when to spend it: the user just
     * launched the app and is looking at it. The alternative is what the
     * ambient log recorded — the first read happening ninety seconds later
     * inside her unprompted greeting, which died as `noKey` while a password
     * dialog waited behind everything else. Never awaited, for the same
     * reason `refreshConfigured` is not.
     */
    const provider = stored.provider ?? DEFAULTS.provider;
    if (provider) void ipc.warmKey(provider).catch(() => {});
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
    // The search key is not a provider, but it lives in the same credential
    // store and the UI asks the same question of it — "is this configured?" —
    // so it rides in the same list rather than growing a parallel one.
    const searchKey = await ipc.hasKey(SEARCH_ACCOUNT).catch(() => false);
    const ready = checks.filter((c) => c.ok).map((c) => c.id);
    set({ configured: searchKey ? [...ready, SEARCH_ACCOUNT] : ready });
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
      searchEngineId,
      profile,
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
      searchEngineId,
      profile,
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
/**
 * Whether this turn can search at all, by either route.
 *
 * Two different mechanisms end up behind one toggle, and that is deliberate —
 * the user is asking "may she look things up?", not "which search
 * implementation should run". Providers with their own search use it; everyone
 * else gets the tool pair in `search/mod.rs`, which needs a key and an engine
 * id the user supplies.
 */
export function searchAvailable(_state: ConfigStore): boolean {
  /*
   * Always. There is nothing left to configure.
   *
   * This used to return false unless a Google Programmable Search key and
   * engine id had been set up, which made a greyed-out switch the first thing
   * most people saw — and the way to un-grey it was a Cloud console, an API to
   * enable, a key to mint and a search engine to create. Nobody does that for a
   * desktop companion, so in practice the feature did not exist.
   *
   * The keyless backend needs no setup at all, so the only honest answer to
   * "can she look things up?" is yes. The parameter stays for the call sites
   * and because a provider-specific reason to say no may return.
   */
  return true;
}

/**
 * Whether the optional full-web upgrade is configured.
 *
 * Not a precondition for searching — only for searching the whole web rather
 * than the encyclopedia. Settings uses this to say which one is in play.
 */
export function fullWebSearchReady(state: ConfigStore): boolean {
  return state.searchEngineId.trim().length > 0 && state.configured.includes(SEARCH_ACCOUNT);
}


