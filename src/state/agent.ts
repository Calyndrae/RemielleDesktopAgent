import { create } from "zustand";
import type { AgentState, PackAnimation, PackManifest } from "@/types/pack";
import { STATE_FALLBACKS } from "@/types/pack";

interface AgentStore {
  /** What the character is doing. The chat flow writes into this. */
  state: AgentState;
  /**
   * Animation forced by `/emote change <id>`, overriding the state mapping
   * until the state changes again.
   */
  emoteOverride: string | null;
  setState: (state: AgentState) => void;
  setEmoteOverride: (animationId: string | null) => void;
}

export const useAgentStore = create<AgentStore>((set) => ({
  state: "idle",
  emoteOverride: null,

  setState: (state) =>
    // A state change is the app taking over; a manual emote shouldn't outlive it.
    set({ state, emoteOverride: null }),

  setEmoteOverride: (emoteOverride) => set({ emoteOverride }),
}));

/**
 * Picks which animation to draw.
 *
 * Resolution order: manual emote override, then the pack's mapping for the
 * current state, then the state's fallback chain, then the first animation in
 * the pack. The last step matters — a pack that somehow validated but can't
 * serve this state should still draw *something* rather than leave a hole on
 * the desktop.
 */
export function resolveAnimation(
  pack: PackManifest,
  state: AgentState,
  emoteOverride: string | null,
): PackAnimation | null {
  const byId = (id: string | undefined) =>
    id ? pack.animations.find((animation) => animation.id === id) : undefined;

  if (emoteOverride) {
    const forced = byId(emoteOverride);
    if (forced) return forced;
  }

  const direct = byId(pack.states[state]);
  if (direct) return direct;

  const fallbackState = STATE_FALLBACKS[state];
  const fallback = byId(pack.states[fallbackState]);
  if (fallback) return fallback;

  const idle = byId(pack.states["idle"]);
  if (idle) return idle;

  return pack.animations[0] ?? null;
}
