import { useLayoutEffect, useRef } from "react";

import { COUNTER_THRESHOLD, MAX_INPUT_LENGTH, useChatStore } from "@/state/chat";
import { Icon } from "./icons";

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
    // left alone, or committing a Chinese candidate would send the message.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      useChatStore.getState().send();
    }
  };

  const remaining = MAX_INPUT_LENGTH - draft.length;
  const showCounter = draft.length >= COUNTER_THRESHOLD;
  const canSend = draft.trim().length > 0;

  return (
    <div className="composer-wrap">
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

        {/*
          Reading order matches importance: attach, then the model as quiet
          metadata, then the counter, then voice, then send. The send button is
          the only filled control in the row.
        */}
        <div className="composer__row">
          <button type="button" className="iconbtn" title="更多" aria-label="更多">
            <Icon.Plus size={17} />
          </button>

          <button type="button" className="modelpill" title="切换模型">
            <span className="modelpill__name">DeepSeek</span>
            <span className="modelpill__variant">Reasoner</span>
            <Icon.ChevronDown size={12} className="modelpill__caret" />
          </button>

          <div className="composer__spacer" />

          {showCounter && (
            <span
              className={`composer__counter${
                remaining <= 0 ? " composer__counter--limit" : ""
              }`}
            >
              {remaining}
            </span>
          )}

          <button type="button" className="iconbtn" title="语音输入" aria-label="语音输入">
            <Icon.Mic size={17} />
          </button>

          {streaming ? (
            <button
              type="button"
              className="sendbtn sendbtn--stop"
              onClick={() => useChatStore.getState().stop()}
              title="停止生成"
              aria-label="停止生成"
            >
              <Icon.Stop size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="sendbtn"
              disabled={!canSend}
              onClick={() => useChatStore.getState().send()}
              title="发送"
              aria-label="发送"
            >
              <Icon.ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>

      <p className="disclaimer">蕾米埃尔也会出错，重要信息请自行确认。</p>
    </div>
  );
}
