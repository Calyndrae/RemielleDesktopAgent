/** Mirrors the Rust types in `src-tauri/src/assets.rs`. */

export interface Offset {
  x: number;
  y: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

export interface PackAnimation {
  id: string;
  /** Display names keyed by locale, e.g. `{ "zh-CN": "待机", en: "Idle" }`. */
  label: Record<string, string>;
  file: string;
  /**
   * Correction applied when drawing, in pack-space pixels. Animations don't
   * share a registration point, so without this the character jumps when the
   * state changes.
   */
  offset: Offset;
  /** Absolute path on disk; run through `convertFileSrc` before use. */
  path: string;
  /** Whether `/emote change` should offer this animation. */
  selectable: boolean;
}

export interface PackManifest {
  id: string;
  name: string;
  license: string;
  credits: string[];
  frameSize: FrameSize;
  animations: PackAnimation[];
  /** Agent state -> animation id. */
  states: Record<string, string>;
}

/**
 * What the character is doing. Drives which animation plays, and is the single
 * source of truth the chat flow writes into.
 */
export type AgentState =
  | "idle"
  | "penIdle"
  | "thinking"
  | "writing"
  | "writingPaused"
  | "expect"
  | "pleased"
  | "confused";

/** States a pack must map, mirroring `REQUIRED_STATES` on the Rust side. */
export const REQUIRED_STATES = ["idle", "thinking", "writing"] as const;

/**
 * Fallbacks used when a pack doesn't map an optional state — every state
 * resolves to something drawable rather than rendering an empty sprite.
 */
export const STATE_FALLBACKS: Record<AgentState, AgentState> = {
  idle: "idle",
  penIdle: "idle",
  thinking: "thinking",
  writing: "writing",
  writingPaused: "writing",
  expect: "idle",
  pleased: "idle",
  confused: "idle",
};
