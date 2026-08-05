import { useLayoutEffect, useRef } from "react";

import {
  COUNTER_THRESHOLD,
  MAX_INPUT_LENGTH,
  useChatStore,
} from "@/state/chat";

/** Textarea stops growing here and scrolls internally instead. */
const MAX_TEXTAREA_HEIGHT = 132;

export function Composer() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const draft = useChatStore((s) => s.draft);
  const streaming = useChatStore((s) => s.streaming);

  // Grow to fit the content, then hand over to the scrollbar. Resetting to
  // `auto` first is what lets it shrink again when text is deleted.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [draft]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter inserts a newline; plain Enter sends. IME composition must be
    // left alone or Chinese input commits its candidate and sends at once.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      useChatStore.getState().send();
    }
  };

  const remaining = MAX_INPUT_LENGTH - draft.length;
  const showCounter = draft.length >= COUNTER_THRESHOLD;
  const canSend = draft.trim().length > 0;

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        className="composer__input"
        value={draft}
        placeholder="和蕾米埃尔说点什么…"
        maxLength={MAX_INPUT_LENGTH}
        rows={1}
        onChange={(event) => useChatStore.getState().setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      <div className="composer__row">
        <button type="button" className="composer__icon" title="更多" aria-label="更多">
          +
        </button>

        <button type="button" className="composer__model" title="切换模型">
          <span className="composer__model-name">DeepSeek</span>
          <span className="composer__model-variant">Reasoner</span>
        </button>

        <div className="composer__spacer" />

        {showCounter && (
          <span
            className={`composer__counter${remaining <= 0 ? " composer__counter--limit" : ""}`}
          >
            {remaining}
          </span>
        )}

        {streaming ? (
          <button
            type="button"
            className="composer__send composer__send--stop"
            onClick={() => useChatStore.getState().stop()}
            title="停止生成"
            aria-label="停止生成"
          >
            <span className="composer__stop-glyph" />
          </button>
        ) : (
          <button
            type="button"
            className="composer__send"
            disabled={!canSend}
            onClick={() => useChatStore.getState().send()}
            title="发送"
            aria-label="发送"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
