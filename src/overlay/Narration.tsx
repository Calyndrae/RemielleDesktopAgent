import { useEffect, useRef } from "react";

import { useAmbientStore } from "@/state/ambient";
import { useChatStore } from "@/state/chat";
import { useMessages } from "@/i18n/useLocale";
import { getSpriteFrame } from "./spritePosition";
import { useHitRegion } from "./hitRegions";

/**
 * What she says when nobody asked.
 *
 * A speech bubble beside her, not a notification and not a panel. The
 * difference matters: a notification is the system telling you something, and
 * this is a character remarking on something. It never steals focus, it never
 * blocks, and it goes away on its own.
 */

/** How long a line stays up if it is simply ignored. */
const HOLD_MS = 14_000;

/** Gap between her edge and the bubble. Matches the chat panel's own. */
const GAP = 14;

export function Narration() {
  const m = useMessages();
  const narration = useAmbientStore((s) => s.narration);
  const panelOpen = useChatStore((s) => s.phase !== "closed");
  const ref = useRef<HTMLDivElement>(null);

  // Only while it is up. Registering an empty rect the rest of the time would
  // put a permanent hole in the passthrough where the bubble used to be.
  useHitRegion("narration", ref, narration !== null);

  /*
   * Placed against her live position rather than laid out in flow.
   *
   * She can be anywhere in the work area and can be dragged mid-sentence, so
   * the bubble is positioned from `getSpriteFrame()` the same way the chat
   * panel is, and flips to whichever side has room.
   */
  useEffect(() => {
    const element = ref.current;
    if (!element || !narration) return;

    const place = () => {
      const sprite = getSpriteFrame();
      const box = element.getBoundingClientRect();
      const spriteLeft = sprite.centreX - sprite.width / 2;
      const spriteRight = sprite.centreX + sprite.width / 2;

      const roomRight = window.innerWidth - spriteRight;
      const toRight = roomRight >= box.width + GAP * 2;

      const x = toRight ? spriteRight + GAP : spriteLeft - GAP - box.width;
      // Slightly above her centre: a bubble level with her middle reads as
      // covering her, one above reads as coming from her.
      const y = sprite.centreY - sprite.height * 0.38 - box.height;

      element.style.left = `${Math.max(GAP, Math.min(x, window.innerWidth - box.width - GAP))}px`;
      element.style.top = `${Math.max(GAP, y)}px`;
    };

    place();
    // She may be dragged while it is up.
    const frame = window.setInterval(place, 250);
    return () => window.clearInterval(frame);
  }, [narration]);

  /*
   * It expires on its own, and opening the panel takes it down early.
   *
   * Talking to her supersedes whatever she said unprompted — leaving the bubble
   * up next to an open conversation would be her interrupting herself.
   */
  useEffect(() => {
    if (!narration) return;
    if (panelOpen) {
      useAmbientStore.getState().say(null);
      return;
    }
    const timer = window.setTimeout(() => useAmbientStore.getState().say(null), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [narration, panelOpen]);

  if (!narration) return null;

  return (
    <div ref={ref} className="narration" role="status" aria-live="polite">
      <p className="narration__text">{narration}</p>

      <div className="narration__actions">
        <button
          type="button"
          className="narration__btn"
          onClick={() => {
            // Answering is the point of her having spoken. Clearing first means
            // the bubble does not linger behind the opening panel.
            useAmbientStore.getState().say(null);
            useChatStore.getState().openPanel();
          }}
        >
          {m.narration.reply}
        </button>
        <button
          type="button"
          className="narration__btn narration__btn--quiet"
          // The escape hatch, and it has to be right here rather than in
          // settings. Someone who wants her to stop is being interrupted *now*,
          // and making them go and find a preference is the wrong answer to
          // that.
          onClick={() => useAmbientStore.getState().muteForToday()}
        >
          {m.narration.muteToday}
        </button>
      </div>
    </div>
  );
}
