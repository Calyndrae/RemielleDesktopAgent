import { useLayoutEffect, useRef, useState } from "react";

import { exportFilename, exportSession } from "@/lib/exportSession";
import { copyText, saveText } from "@/lib/saveText";
import { COUNTER_THRESHOLD, MAX_INPUT_LENGTH, useChatStore } from "@/state/chat";
import { currentProvider, searchAvailable, useConfigStore } from "@/state/config";
import { openSettings } from "@/lib/settingsWindow";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { Icon } from "./icons";

/** Textarea stops growing here and scrolls internally instead. */
const MAX_TEXTAREA_HEIGHT = 132;

export function Composer() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const draft = useChatStore((s) => s.draft);
  const streaming = useChatStore((s) => s.streaming);
  const messages = useChatStore((s) => s.messages);
  const toast = useChatStore((s) => s.toast);

  const model = useConfigStore((s) => s.model);
  const webSearch = useConfigStore((s) => s.webSearch);
  const providerLabel = useConfigStore((s) => currentProvider(s)?.label ?? s.provider);
  const canSearch = useConfigStore(searchAvailable);

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

  /**
   * What the "+" opens.
   *
   * Its whole job is getting this conversation *out* — a companion that can
   * only be talked to inside its own window is a worse companion. Copying is
   * listed above saving because pasting into another assistant is the common
   * case and the clipboard is one step shorter than a file.
   */
  const hasTranscript = messages.some((m) => m.chunks.join("").trim().length > 0);

  const exportOptions = () => {
    const config = useConfigStore.getState();
    return { model: config.model, provider: currentProvider(config)?.label ?? config.provider };
  };

  const flash = (text: string) => useChatStore.getState().notify(text);

  const menuItems: MenuItem[] = [
    {
      id: "copy-handoff",
      label: "复制「接力」文本",
      disabled: !hasTranscript,
      onSelect: () => {
        const text = exportSession(messages, { ...exportOptions(), format: "handoff" });
        void copyText(text).then((ok) =>
          flash(ok ? "已复制，粘到别的助手即可接着聊" : "剪贴板被拒绝了"),
        );
      },
    },
    {
      id: "copy-markdown",
      label: "复制为 Markdown",
      disabled: !hasTranscript,
      onSelect: () => {
        const text = exportSession(messages, { ...exportOptions(), format: "markdown" });
        void copyText(text).then((ok) => flash(ok ? "已复制 Markdown" : "剪贴板被拒绝了"));
      },
    },
    {
      id: "save-json",
      label: "导出 JSON 存档",
      disabled: !hasTranscript,
      onSelect: () => {
        const text = exportSession(messages, {
          ...exportOptions(),
          format: "json",
          includeReasoning: true,
        });
        void saveText(exportFilename("json"), text).then((ok) => {
          if (ok) flash("已导出");
        });
      },
    },
    {
      id: "new-chat",
      label: "开始新对话",
      disabled: messages.length === 0,
      onSelect: () => useChatStore.getState().reset(),
    },
  ];

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
          Two clusters, not one line of five things.
          Left is about the conversation: what to do with it, and which model is
          answering. Right is about *this message*: whether it may search, how
          much room is left, and send.

          The split matters because the search toggle and the send button are
          both small round controls. Sitting at opposite ends of a spacer, they
          read as a pair that had been broken apart — similarity says they
          belong together, distance says they do not, and the eye believes
          similarity. Putting them side by side makes the grouping true instead
          of arguing with it.
        */}
        <div className="composer__row">
          <button
            ref={plusRef}
            type="button"
            className={`iconbtn${menu ? " iconbtn--open" : ""}`}
            title="导出与新对话"
            aria-label="导出与新对话"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={() => {
              if (menu) {
                setMenu(null);
                return;
              }
              const box = plusRef.current?.getBoundingClientRect();
              // Opens upward: the button sits near the bottom of the panel, and
              // a downward menu would land off the work area.
              if (box) setMenu({ x: box.left, y: box.top - 6 });
            }}
          >
            <Icon.Plus size={17} />
          </button>

          <button
            type="button"
            className="modelpill"
            title={`${providerLabel} · ${model || "未选择模型"} —— 在设置里切换`}
            onClick={openSettings}
          >
            <span className="modelpill__name">{providerLabel}</span>
            <span className="modelpill__variant">{model || "未选择模型"}</span>
            <Icon.ChevronDown size={12} className="modelpill__caret" />
          </button>

          <div className="composer__spacer" />

          {/* "30" alone reads as a quantity of something unnamed. */}
          {showCounter && (
            <span
              className={`composer__counter${
                remaining <= 0 ? " composer__counter--limit" : ""
              }`}
              title={`最多 ${MAX_INPUT_LENGTH} 字`}
            >
              还剩 {remaining} 字
            </span>
          )}

          {/*
            Shown only when the provider actually has search. An enabled-looking
            switch that silently does nothing is worse than no switch.
          */}
          {canSearch && (
            <button
              type="button"
              className={`searchtoggle${webSearch ? " searchtoggle--on" : ""}`}
              aria-pressed={webSearch}
              // The label has to move here rather than be hidden with CSS: the
              // span was the button's only accessible name.
              aria-label={webSearch ? "联网搜索已开启" : "联网搜索已关闭"}
              onClick={() => useConfigStore.getState().patch({ webSearch: !webSearch })}
              title={
                webSearch
                  ? "联网搜索已开启 —— 点击关闭"
                  : "联网搜索已关闭 —— 点击开启"
              }
            >
              {webSearch ? <Icon.Globe size={15} /> : <Icon.GlobeOff size={15} />}
            </button>
          )}

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

      {toast && (
        <p className="toast" role="status">
          {toast}
        </p>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          above
          regionId="composer-menu"
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
