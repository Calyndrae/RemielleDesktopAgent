import { useEffect, useRef } from "react";

import { nextDelayMs, pickActivity } from "@/lib/ambient";
import { buildFacts } from "@/lib/ambientFacts";
import { ipc } from "@/lib/ipc";
import { isReady, useConfigStore } from "@/state/config";
import { ambientEmotePool, useAgentStore } from "@/state/agent";
import { SLEEP_AFTER_MS, useAmbientStore } from "@/state/ambient";
import { useChatStore } from "@/state/chat";
import type { PackManifest } from "@/types/pack";

/**
 * Drives everything she does on her own.
 *
 * Two timers with different jobs, deliberately not merged. The activity timer
 * is about her initiative and answers to quiet hours, the daily cap and the
 * mute; the sleep timer is about *your* absence and answers to none of them,
 * because dozing off is not an interruption and waking is free.
 *
 * Both stand down entirely while the chat panel is open. That is the whole
 * bargain: her idle behaviour is company while you are working, and the moment
 * you are actually talking to her it would be interruption.
 */
export function useAmbient(pack: PackManifest | null): void {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const packRef = useRef(pack);
  packRef.current = pack;

  /*
   * When the keyboard or mouse was last touched.
   *
   * Kept here rather than derived from the sleep timer because the two answer
   * different questions: that one asks "should she doze", this one is a fact
   * she gets to remark on. A ref, because it is written on every pointer move
   * and nothing should re-render for it.
   */
  const lastInputRef = useRef(Date.now());
  useEffect(() => {
    const touch = () => {
      lastInputRef.current = Date.now();
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true });
    return () => {
      for (const name of events) window.removeEventListener(name, touch);
    };
  }, []);

  // ---- the activity schedule ----
  useEffect(() => {
    const schedule = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(run, nextDelayMs(useAmbientStore.getState().settings));
    };

    const run = () => {
      const ambient = useAmbientStore.getState();
      const agent = useAgentStore.getState();

      /*
       * Re-checked at fire time, not at schedule time.
       *
       * An hour can pass between the two, and in that hour the user may have
       * opened the panel, crossed into quiet hours, or asked her to stop for
       * the day. Deciding an hour early is deciding on stale facts.
       */
      if (agent.canRunAmbient() && ambient.blockedBy() === null) {
        if (pickActivity() === "emote") {
          changeEmote(packRef.current);
          ambient.noteFired();
        } else {
          // Fire-and-forget: the schedule must not wait on a network call, and
          // a greeting that arrives late is still a greeting.
          void speak(lastInputRef.current);
        }
      }

      schedule();
    };

    schedule();
    return () => clearTimeout(timer.current);
  }, []);

  // ---- dozing off ----
  useEffect(() => {
    let sleepTimer: ReturnType<typeof setTimeout>;

    const wake = () => {
      const ambient = useAmbientStore.getState();
      if (ambient.asleep) {
        ambient.setAsleep(false);
        const chat = useChatStore.getState();
        useAgentStore
          .getState()
          .setState(chat.phase === "closed" ? "idle" : "penIdle");
      }
      clearTimeout(sleepTimer);
      sleepTimer = setTimeout(doze, SLEEP_AFTER_MS);
    };

    const doze = () => {
      // Never mid-conversation: a panel that is open means she is being talked
      // to, whether or not the cursor has moved recently.
      if (useChatStore.getState().phase !== "closed") return;
      if (!useAgentStore.getState().canRunAmbient()) return;

      useAmbientStore.getState().setAsleep(true);
      useAgentStore.getState().setState("sleep");
    };

    // Any of these counts as "you are still here". Pointer movement over the
    // overlay only reaches us when the cursor is over her or over a panel, but
    // that is exactly the interaction worth waking for.
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, wake, { passive: true });

    sleepTimer = setTimeout(doze, SLEEP_AFTER_MS);
    return () => {
      clearTimeout(sleepTimer);
      for (const name of events) window.removeEventListener(name, wake);
    };
  }, []);
}

/**
 * How long an unprompted pose lasts before she settles back.
 *
 * A flourish, not a new resting state. The scheduler fires somewhere between 45
 * and 120 minutes apart, so leaving the pose in place would mean sitting in it
 * for the whole gap — an hour of standing there mid-brushstroke, which reads as
 * a stuck animation rather than as a character with something on her mind.
 *
 * Her baseline is idle, and everything else is temporary.
 */
const EMOTE_HOLD_MIN_MS = 12_000;
const EMOTE_HOLD_MAX_MS = 26_000;

let holdTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Plays one pose for a few seconds, then returns her to idle.
 *
 * Never picks a pose bound to a conversational state — see `ambientEmotePool`.
 * The drawing animations mean "writing you a reply", and playing one when
 * nothing is being written is a lie the user has no way to see through.
 */
function changeEmote(pack: PackManifest | null): void {
  if (!pack) return;

  const options = ambientEmotePool(pack);
  const { emoteOverride, setEmoteOverride } = useAgentStore.getState();
  const others = options.filter((animation) => animation.id !== emoteOverride);
  const next = others[Math.floor(Math.random() * others.length)];
  if (!next) return;

  setEmoteOverride(next.id);

  clearTimeout(holdTimer);
  const hold =
    EMOTE_HOLD_MIN_MS + Math.random() * (EMOTE_HOLD_MAX_MS - EMOTE_HOLD_MIN_MS);

  holdTimer = setTimeout(() => {
    // Only if it is still ours. A state change or an explicit `/emote change`
    // in the meantime has already decided what she should be doing, and
    // clearing here would undo the user's own choice.
    if (useAgentStore.getState().emoteOverride === next.id) {
      setEmoteOverride(null);
    }
  }, hold);
}

/**
 * Asks her for a line, and shows it if one comes back.
 *
 * Everything here is best-effort. She speaks unprompted, which means nobody is
 * waiting for this and nobody should be told when it does not work: a failed
 * greeting is a moment that quietly did not happen, not an error worth a
 * toast. The one thing that *is* worth being strict about is not counting a
 * greeting that never appeared against the daily cap.
 */
async function speak(lastInputAt: number): Promise<void> {
  const config = useConfigStore.getState();

  // Nothing to ask. She has no voice until a provider is configured, and
  // silently doing nothing is the right behaviour rather than an error.
  if (!isReady(config)) return;

  const ambient = useAmbientStore.getState();

  /*
   * The foreground app, only with permission.
   *
   * `get_active_window` is a switch the user owns, and it governs this for the
   * same reason it governs the tool: it is the same fact about the same screen.
   * Reading it here regardless would route around a "no" the user had already
   * given.
   */
  const mayReadWindow = config.tools.includes("get_active_window");
  const activeApp = mayReadWindow
    ? await ipc.activeWindowName().catch(() => null)
    : null;

  const facts = buildFacts({
    now: new Date(),
    idleMs: Date.now() - lastInputAt,
    firedToday: ambient.runtime.firedToday,
    activeApp,
  });

  try {
    const line = await ipc.ambientLine({
      provider: config.provider,
      baseUrl: config.baseUrl.trim() || null,
      model: config.model,
      system: config.systemPrompt.trim() || null,
      facts,
    });
    if (!line) return;

    /*
     * Re-checked after the round trip, not before it.
     *
     * A model can take several seconds, and in those seconds the user may have
     * opened the panel or asked her to stop for the day. Showing a line decided
     * before that would be her ignoring an instruction she was given while she
     * was thinking.
     */
    const now = useAmbientStore.getState();
    if (now.blockedBy() !== null) return;
    if (useChatStore.getState().phase !== "closed") return;

    now.say(line);
    // Counted only now. A greeting that failed, or that arrived after the user
    // said stop, has not been spent.
    now.noteFired();
  } catch {
    // Deliberately silent. See the note above.
  }
}
