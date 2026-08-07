import { create } from "zustand";
import type { AgentState, PackAnimation, PackManifest } from "@/types/pack";
import { STATE_FALLBACKS } from "@/types/pack";

/**
 * The shortest time a state may stay on screen.
 *
 * Each state maps to its own animation, and switching states restarts the
 * animation from frame one. A fast model can go thinking → writing in under
 * 200ms, which showed a single frame of the thinking pose and then threw it
 * away — the character appeared to twitch rather than to think. Holding each
 * state briefly turns that into a readable beat.
 *
 * This is a floor, not a delay: a state that is already older than the floor
 * changes immediately.
 */
export const MIN_DWELL_MS = 420;

interface AgentStore {
  /** What the character is doing. The chat flow writes into this. */
  state: AgentState;
  /**
   * Animation forced by `/emote change <id>`, overriding the state mapping
   * until the state changes again.
   */
  emoteOverride: string | null;
  /**
   * Whether the ambient scheduler — the one that idly swaps animations and
   * starts conversations on its own — is allowed to act.
   *
   * Suspended for as long as the chat panel is open. Her idle behaviour is
   * company while you are working; the moment you are actually talking to her
   * it becomes interruption. Nothing about the mood is lost, it just stops
   * advancing: whatever she was doing when you opened the panel is still what
   * she goes back to when the reply lands and when you close it.
   */
  ambientSuspended: boolean;

  setState: (state: AgentState) => void;
  setEmoteOverride: (animationId: string | null) => void;
  suspendAmbient: (suspended: boolean) => void;
  /** True when the ambient scheduler may swap an animation right now. */
  canRunAmbient: () => boolean;
}

let dwellTimer: ReturnType<typeof setTimeout> | undefined;
let enteredAt = 0;

/** Drops a queued change. The floor itself keeps running. */
function clearDwellTimer(): void {
  clearTimeout(dwellTimer);
  dwellTimer = undefined;
}

/**
 * Drops a queued change *and* the floor with it.
 *
 * Called when the panel closes. The floor exists to keep one exchange from
 * flickering; carrying it across a close would make the first transition of the
 * next conversation arrive late for no reason. Distinct from the internal
 * `clearDwellTimer` on purpose — superseding a queued state must not also reset
 * how long the current one has been showing, or the floor would never apply.
 */
export function cancelPendingState(): void {
  clearDwellTimer();
  enteredAt = 0;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  state: "idle",
  emoteOverride: null,
  ambientSuspended: false,

  setState: (next) => {
    clearDwellTimer();
    if (next === get().state) return;

    const commit = () => {
      enteredAt = Date.now();
      dwellTimer = undefined;
      // A state change is the app taking over; a manual emote shouldn't
      // outlive it.
      set({ state: next, emoteOverride: null });
    };

    const held = Date.now() - enteredAt;
    if (held >= MIN_DWELL_MS) commit();
    else dwellTimer = setTimeout(commit, MIN_DWELL_MS - held);
  },

  setEmoteOverride: (emoteOverride) => set({ emoteOverride }),

  suspendAmbient: (ambientSuspended) => set({ ambientSuspended }),

  canRunAmbient: () => !get().ambientSuspended,
}));

/**
 * Where the character goes when nothing is happening.
 *
 * There is no "finished" pose. A reply completing is the *absence* of an
 * activity, not an activity of its own, so it resolves to whichever resting
 * state the context calls for rather than to a celebration on a timer. The
 * previous behaviour — a 1.5s "pleased" animation wedged between writing and
 * idle — made a six-second exchange flash through four different animations,
 * and the last one was the one nobody asked for.
 */
export function restingState(panelOpen: boolean): AgentState {
  return panelOpen ? "penIdle" : "idle";
}

/**
 * The states that describe what she is doing *with the conversation*.
 *
 * An animation bound to one of these is not decoration — it is a claim. Playing
 * the drawing pose at random says "I am writing you a reply" when nothing is
 * being written; the pen-idle pose says "the chat is open" when it is not.
 */
const CONVERSATIONAL_STATES: readonly AgentState[] = [
  "idle",
  "penIdle",
  "thinking",
  "writing",
  "writingPaused",
];

/**
 * Animations the idle scheduler may pick from.
 *
 * Everything selectable, minus anything that is bound to a conversational
 * state — including `idle` itself, which is the baseline and so is not a
 * change. What is left is the poses that mean nothing in particular, which is
 * exactly what an unprompted flourish should be made of.
 *
 * An empty result is a correct answer, not a problem to work around: a pack
 * that maps every animation it ships has nothing spare to play, and picking one
 * anyway would be picking a lie.
 */
export function ambientEmotePool(pack: PackManifest): PackAnimation[] {
  const claimed = new Set(
    CONVERSATIONAL_STATES.map((state) => pack.states[state]).filter(Boolean),
  );
  return pack.animations.filter(
    (animation) => animation.selectable && !claimed.has(animation.id),
  );
}

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
