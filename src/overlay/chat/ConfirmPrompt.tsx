import { useEffect, useRef } from "react";

import { useChatStore } from "@/state/chat";
import { useMessages } from "@/i18n/useLocale";

/**
 * The one place she has to stop and ask.
 *
 * `Confirm`-tier tools — a full antivirus scan, anything slow or awkward to
 * reverse — park here until you answer. Deliberately in the panel rather than a
 * native dialog: a modal box appearing over the desktop with no context is how
 * users learn to click "yes" without reading, and the whole point of the tier
 * is that this one gets read.
 *
 * There is no "don't ask again". If a tool is disruptive enough to need asking,
 * it is disruptive enough to need asking every time; a remembered "yes" is the
 * same as not having the tier at all.
 *
 * Closing the panel or cancelling the reply drops the prompt, and a dropped
 * prompt means no — the Rust side treats a lost sender as a refusal, so there
 * is no path where silence starts something.
 */
export function ConfirmPrompt() {
  const m = useMessages();
  const pending = useChatStore((s) => s.confirm);
  const denyRef = useRef<HTMLButtonElement>(null);

  // Focus lands on "不用" rather than "去吧". A prompt that appears under the
  // cursor mid-typing must not be one Enter away from running a scan.
  useEffect(() => {
    if (pending) denyRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") useChatStore.getState().answerConfirm(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  if (!pending) return null;

  return (
    <div className="confirm" role="alertdialog" aria-labelledby="confirm-title">
      <p className="confirm__title" id="confirm-title">
        {m.chat.confirmTitle(pending.label)}
      </p>
      {pending.detail && (
        <p className="confirm__detail">{m.chat.confirmScope(pending.detail)}</p>
      )}
      <div className="confirm__row">
        <button
          ref={denyRef}
          type="button"
          className="confirm__btn"
          onClick={() => useChatStore.getState().answerConfirm(false)}
        >
          {m.chat.confirmDeny}
        </button>
        <button
          type="button"
          className="confirm__btn confirm__btn--go"
          onClick={() => useChatStore.getState().answerConfirm(true)}
        >
          {m.chat.confirmAllow}
        </button>
      </div>
    </div>
  );
}
