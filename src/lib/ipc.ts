/** Typed wrappers over the Rust commands. Mirrors `src-tauri/src/`. */

import { invoke } from "@tauri-apps/api/core";
import type { PackManifest } from "@/types/pack";
import type { Messages } from "@/i18n";
import { zhCN } from "@/i18n/zh-CN";

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

/** Tray menu strings. Mirrors `TrayLabels` in `src-tauri/src/window/tray.rs`. */
export interface TrayLabels {
  show: string;
  hide: string;
  recentre: string;
  settings: string;
  quit: string;
}

export const ipc = {
  /** Places the overlay over the work area and reveals it. */
  overlayReady: () => invoke<OverlayGeometry>("overlay_ready"),

  /** Re-places the overlay after a display change. */
  refreshOverlayGeometry: () => invoke<OverlayGeometry>("refresh_overlay_geometry"),

  /**
   * Puts the overlay back onto a real display, unconditionally.
   *
   * The manual counterpart to the automatic stranding check in Rust, which is
   * deliberately conservative and only fires when she overlaps no display at
   * all. This one does not ask.
   */
  recentreOverlay: () => invoke<OverlayGeometry>("recentre_overlay"),

  /**
   * "Stay above other windows", including above fullscreen apps.
   *
   * Not `getCurrentWindow().setAlwaysOnTop()`. That sets the floating window
   * level, which wins against ordinary windows and loses to a fullscreen Space
   * — so the setting read as on while she vanished behind anything fullscreen.
   * The macOS half of the job needs a window level and a collection behaviour
   * that Tauri does not expose, so both halves live in Rust together.
   */
  setOverlayOnTop: (on: boolean) => invoke<void>("set_overlay_on_top", { on }),
  /** Registers (or clears, with null) the global summon shortcut. */
  setSummonShortcut: (shortcut: string | null) =>
    invoke<void>("set_summon_shortcut", { shortcut }),
  /**
   * Asks the app to uninstall itself, behind a native confirmation.
   * Deliberately a command and not a catalog tool: no model can reach it.
   */
  uninstallApp: () => invoke<void>("uninstall_app"),
  /** Checks GitHub, installs any newer release, returns what happened. */
  checkForUpdate: (promptRestart: boolean) =>
    invoke<{ state: "current" | "installed"; version: string }>(
      "check_for_update",
      { promptRestart },
    ),

  /**
   * Replaces the tray menu's strings once the locale is known.
   *
   * The tray is built during setup, before this webview exists, so it starts on
   * the Simplified Chinese defaults compiled into Rust. Sending them again in
   * the resolved locale is what makes the tray bilingual.
   */
  setTrayLabels: (labels: TrayLabels) => invoke<void>("set_tray_labels", { labels }),

  /**
   * Hides the overlay.
   *
   * Goes through Rust rather than calling `window.hide()` directly so the tray's
   * toggle flips to "come out" in the same step. The tray is the only way back
   * from here, and a tray still offering to hide an already-hidden companion
   * reads as broken.
   */
  hideOverlay: () => invoke<void>("hide_overlay"),

  /** Opaque interaction areas: chat panel, context menu, toasts. */
  setHitRegions: (regions: Rect[]) => invoke<void>("set_hit_regions", { regions }),

  /** The sprite's position plus the alpha mask of its current frame. */
  setSpriteMask: (mask: SpriteMask | null) => invoke<void>("set_sprite_mask", { mask }),

  /** Pins the overlay interactive for the duration of a drag. */
  setForceInteractive: (enabled: boolean) =>
    invoke<void>("set_force_interactive", { enabled }),

  loadPack: (id: string) => invoke<PackManifest>("load_pack", { id }),
  listPacks: () => invoke<PackManifest[]>("list_packs"),
  /** Native file picker for the app allowlist. Null when the user cancels. */
  pickApp: () => invoke<AppEntry | null>("pick_app"),

  // --- secrets ---
  // There is deliberately no `getKey`. The frontend can store, delete, and ask
  // whether a key exists; it can never read one back. See src-tauri/src/secrets.rs.
  storeKey: (account: string, key: string) =>
    invoke<void>("store_key", { account, key }),
  hasKey: (account: string) => invoke<boolean>("has_key", { account }),
  /**
   * Reads a key into the backend's process cache. Never returns it.
   *
   * Called once at startup so the single Keychain approval lands while the
   * user is watching their own launch, rather than ninety seconds later
   * underneath her greeting. See `warm_key` in src-tauri/src/secrets.rs.
   */
  warmKey: (account: string) => invoke<boolean>("warm_key", { account }),
  deleteKey: (account: string) => invoke<void>("delete_key", { account }),
  keyHint: (account: string) => invoke<string | null>("key_hint", { account }),

  // --- providers / chat ---
  listProviders: () => invoke<ProviderInfo[]>("list_providers"),
  /** Offline format check, for feedback as the user types. */
  checkKey: (providerId: string, key: string) =>
    invoke<KeyFormatIssue | null>("check_key", { providerId, key }),
  verifyKey: (providerId: string, baseUrl: string | null, key: string) =>
    invoke<string[]>("verify_key", { providerId, baseUrl, key }),
  listModels: (providerId: string, baseUrl: string | null) =>
    invoke<string[]>("list_models", { providerId, baseUrl }),

  /**
   * Puts one line into the app's log file. For the frontend's own anomaly
   * reports — the log is the artifact a user sends when something looks
   * wrong, and the webview console does not survive to be looked at.
   */
  frontendNote: (message: string) => invoke<void>("frontend_note", { message }),

  /**
   * One unprompted line, generated fresh.
   *
   * Deliberately not a template with slots. A companion whose greetings are
   * drawn from a fixed list stops being a character the second time you see the
   * same one — the whole value of this is that the line is hers and is about
   * this particular moment. `facts` are short statements about now; what she
   * does with them is her business.
   */
  ambientLine: (request: AmbientRequest) => invoke<string>("ambient_line", { request }),

  /**
   * Runs one test query against the optional Google credentials.
   *
   * Called at save time, because that is the moment the user can act on a
   * failure. The 403 for "project has no Custom Search API" used to surface
   * mid-conversation instead, where it read as the whole feature being broken.
   */
  verifySearch: (key: string, engineId: string) =>
    invoke<number>("verify_search", { key, engineId }),
  startChat: (streamId: string, request: ChatRequest) =>
    invoke<void>("start_chat", { streamId, request }),
  cancelChat: (streamId: string) => invoke<void>("cancel_chat", { streamId }),
  listTools: () => invoke<ToolSpec[]>("list_tools"),

  /**
   * The foreground application's name, for an unprompted line.
   *
   * Only ever called when `get_active_window` is switched on. It is the same
   * fact about the same screen as the tool of that name, so one switch governs
   * both rather than the user having to say no twice.
   */
  activeWindowName: () => invoke<string | null>("active_window_name"),
  /** Answers a pending `toolConfirm`. */
  resolveToolConfirm: (callId: string, approved: boolean) =>
    invoke<void>("resolve_tool_confirm", { callId, approved }),

  quitApp: () => invoke<void>("quit_app"),
};

export interface ProviderInfo {
  id: string;
  label: string;
  protocol: "openAiCompatible" | "gemini";
  defaultBaseUrl: string;
  keyPrefix: string | null;
  requiresKey: boolean;
  /** Whether the provider has first-party web search. */
  nativeSearch: boolean;
  docsUrl: string;
}

export interface ChatRequest {
  provider: string;
  baseUrl: string | null;
  model: string;
  messages: { role: "user" | "assistant"; content: string }[];
  system: string | null;
  temperature: number | null;
  webSearch: boolean;
  /** Catalog tools the user has switched on. Anything absent is never offered. */
  tools: string[];
  /** Applications `open_app` may launch. Labels reach the model; paths stay in Rust. */
  appAllowlist: AppEntry[];
  /** Programmable Search engine id (`cx`). Public; the key is not sent. */
  searchEngineId: string;
}

/**
 * One allow-listed application. The label is what the model may name and what
 * the transcript shows; the path was chosen in the OS file picker and is only
 * ever resolved back in Rust. No model output can reach it.
 */
export interface AppEntry {
  label: string;
  path: string;
}

export interface AmbientRequest {
  provider: string;
  baseUrl: string | null;
  model: string;
  /** Her voice settings. The identity is added in Rust, as always. */
  system: string | null;
  /** Short statements about the current moment. */
  facts: string[];
}

/** One entry in the tool catalog. Mirrors the Rust `ToolSpec`. */
export interface ToolSpec {
  name: string;
  description: string;
  /** Written for the user. Always shown instead of `name`. */
  userLabel: string;
  /** The English UI's wording for the same switch. */
  userLabelEn: string;
  risk: "read" | "act" | "confirm";
  /** Which part of the machine this touches. Drives the settings grouping. */
  group: "system" | "media" | "window" | "apps" | "herself";
  platform: "any" | "windows";
  params: { name: string; description: string; required: boolean }[];
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/** Something the model did besides writing prose. Surfaced in the transcript. */
export type ToolActivity =
  | { kind: "search"; query: string }
  | { kind: "citation"; title: string; url: string };

/** Mirrors the Rust `StreamEvent` enum. */
export type StreamEvent =
  | { type: "content"; streamId: string; text: string }
  | { type: "reasoning"; streamId: string; text: string }
  | { type: "tool"; streamId: string; activity: ToolActivity }
  | {
      type: "toolCall";
      streamId: string;
      callId: string;
      tool: string;
      label: string;
      risk: "read" | "act" | "confirm";
    }
  | {
      type: "toolResult";
      streamId: string;
      callId: string;
      tool: string;
      summary: string;
      ok: boolean;
    }
  | {
      type: "toolConfirm";
      streamId: string;
      callId: string;
      tool: string;
      label: string;
      detail: string;
    }
  | { type: "usage"; streamId: string; usage: TokenUsage }
  | { type: "done"; streamId: string }
  | { type: "failed"; streamId: string; error: ApiError };

/** Mirrors the Rust `ApiError` enum. Each kind gets its own remedy in the UI. */
export type ApiError =
  | { kind: "invalidKey"; detail: { message: string } }
  | { kind: "forbidden"; detail: { message: string } }
  | { kind: "rateLimited"; detail: { message: string; retryAfter: number | null } }
  | { kind: "unknownModel"; detail: { model: string } }
  | { kind: "upstream"; detail: { status: number; message: string } }
  | { kind: "network"; detail: { message: string } }
  | { kind: "noKey" }
  | { kind: "unknownProvider"; detail: string }
  | { kind: "malformed"; detail: { message: string } }
  | { kind: "cancelled" };

export type KeyFormatIssue =
  | { kind: "empty" }
  | { kind: "containsWhitespace" }
  | { kind: "looksLikeUrl" }
  | { kind: "tooShort" }
  | { kind: "wrongPrefix"; detail: { expected: string } };

/**
 * Plain-language version of an offline key-format complaint.
 *
 * The catalog defaults to Simplified Chinese so plain-TypeScript callers and
 * tests need no ceremony; components pass the current catalog from
 * `useMessages()` so the wording follows the language setting.
 */
export function describeKeyIssue(
  issue: KeyFormatIssue,
  messages: Messages = zhCN,
): string {
  const m = messages.errors.keyIssue;
  switch (issue.kind) {
    case "empty":
      return m.empty;
    case "containsWhitespace":
      return m.containsWhitespace;
    case "looksLikeUrl":
      return m.looksLikeUrl;
    case "tooShort":
      return m.tooShort;
    case "wrongPrefix":
      return m.wrongPrefix(issue.detail.expected);
  }
}

export const CHAT_EVENT = "chat://event";

/**
 * Invoke rejections from our commands are ApiError-shaped, but a rejection can
 * also be a plain string (a panicked command, a plugin error). Wrapping the
 * stragglers means every catch site can hand the result to `describeError`
 * without first playing type detective.
 */
export function asApiError(error: unknown): ApiError {
  return typeof error === "object" && error !== null && "kind" in error
    ? (error as ApiError)
    : { kind: "network", detail: { message: String(error) } };
}

/** Turns a typed provider error into something a person can act on. */
export function describeError(
  error: ApiError,
  messages: Messages = zhCN,
): { title: string; hint: string } {
  const m = messages.errors.api;
  switch (error.kind) {
    case "invalidKey":
      return { title: m.invalidKey.title, hint: m.invalidKey.hint };
    case "forbidden":
      return { title: m.forbidden.title, hint: m.forbidden.hint };
    case "rateLimited": {
      const wait = error.detail.retryAfter;
      return {
        title: m.rateLimitedTitle,
        hint: wait ? m.rateLimitedWait(wait) : m.rateLimitedRetry,
      };
    }
    case "unknownModel":
      return { title: m.unknownModelTitle, hint: m.unknownModelHint(error.detail.model) };
    case "network":
      return { title: m.networkTitle, hint: error.detail.message };
    case "noKey":
      return { title: m.noKey.title, hint: m.noKey.hint };
    case "unknownProvider":
      return { title: m.unknownProviderTitle, hint: error.detail };
    case "malformed":
      return { title: m.malformedTitle, hint: error.detail.message };
    case "upstream":
      return {
        title: m.upstreamTitle(error.detail.status),
        hint: error.detail.message,
      };
    case "cancelled":
      return { title: m.cancelledTitle, hint: "" };
  }
}
