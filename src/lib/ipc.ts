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

  // --- secrets ---
  // There is deliberately no `getKey`. The frontend can store, delete, and ask
  // whether a key exists; it can never read one back. See src-tauri/src/secrets.rs.
  storeKey: (account: string, key: string) =>
    invoke<void>("store_key", { account, key }),
  hasKey: (account: string) => invoke<boolean>("has_key", { account }),
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
  startChat: (streamId: string, request: ChatRequest) =>
    invoke<void>("start_chat", { streamId, request }),
  cancelChat: (streamId: string) => invoke<void>("cancel_chat", { streamId }),
  listTools: () => invoke<ToolSpec[]>("list_tools"),
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
  /** Applications `open_app` may launch. */
  appAllowlist: string[];
  /** Programmable Search engine id (`cx`). Public; the key is not sent. */
  searchEngineId: string;
}

/** One entry in the tool catalog. Mirrors the Rust `ToolSpec`. */
export interface ToolSpec {
  name: string;
  description: string;
  /** Written for the user. Always shown instead of `name`. */
  userLabel: string;
  risk: "read" | "act" | "confirm";
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
  | { type: "toolCall"; streamId: string; callId: string; tool: string; label: string }
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

/** Plain-language version of an offline key-format complaint. */
export function describeKeyIssue(issue: KeyFormatIssue): string {
  switch (issue.kind) {
    case "empty":
      return "还没有输入密钥。";
    case "containsWhitespace":
      return "密钥中间有空格，通常是复制时截断了。";
    case "looksLikeUrl":
      return "这看起来是一个网址，不是密钥。";
    case "tooShort":
      return "密钥太短了，可能没复制完整。";
    case "wrongPrefix":
      return `这个服务商的密钥应该以 ${issue.detail.expected} 开头 —— 可能拿错了服务商的密钥。`;
  }
}

export const CHAT_EVENT = "chat://event";

/** Turns a typed provider error into something a person can act on. */
export function describeError(error: ApiError): { title: string; hint: string } {
  switch (error.kind) {
    case "invalidKey":
      return { title: "密钥被拒绝", hint: "检查密钥是否复制完整，或是否已被吊销。" };
    case "forbidden":
      return { title: "没有权限", hint: "这个密钥可能没有该模型的访问权，或账户余额不足。" };
    case "rateLimited": {
      const wait = error.detail.retryAfter;
      return {
        title: "触发限流",
        hint: wait ? `请等待约 ${wait} 秒后重试。` : "请稍后重试。",
      };
    }
    case "unknownModel":
      return { title: "模型不可用", hint: `当前密钥无法使用 ${error.detail.model}。` };
    case "network":
      return { title: "连不上服务", hint: error.detail.message };
    case "noKey":
      return { title: "还没有配置密钥", hint: "在设置里添加一个 API 密钥。" };
    case "unknownProvider":
      return { title: "未知的服务商", hint: error.detail };
    case "malformed":
      return { title: "返回内容无法解析", hint: error.detail.message };
    case "upstream":
      return {
        title: `服务返回错误 ${error.detail.status}`,
        hint: error.detail.message,
      };
    case "cancelled":
      return { title: "已取消", hint: "" };
  }
}
