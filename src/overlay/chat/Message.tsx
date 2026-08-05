import { memo, useLayoutEffect, useRef, useState } from "react";

import { parseBlocks } from "@/lib/markdownLite";
import { reasoningSummary, useChatStore, type ChatMessage } from "@/state/chat";
import { Icon } from "./icons";

interface MessageProps {
  message: ChatMessage;
  /** The newest assistant turn carries the agent mark and the action row. */
  isLatestAssistant: boolean;
}

/**
 * The chain-of-thought row.
 *
 * Collapsed to a single muted line, because the reasoning is context rather
 * than the answer — but always present and always expandable. Models that emit
 * a visible thought process (DeepSeek and friends) must never have it silently
 * dropped.
 */
function ReasoningRow({
  reasoning,
  thinking,
}: {
  reasoning: string;
  thinking: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!reasoning) {
    return thinking ? (
      <div className="reasoning">
        <span className="reasoning__label reasoning__label--pulsing">思考中…</span>
      </div>
    ) : null;
  }

  return (
    <div className="reasoning">
      <button
        type="button"
        className="reasoning__toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className={`reasoning__label${thinking ? " reasoning__label--pulsing" : ""}`}>
          {thinking ? "思考中…" : reasoningSummary(reasoning)}
        </span>
        <Icon.ChevronRight
          size={13}
          className={`reasoning__chevron${expanded ? " reasoning__chevron--open" : ""}`}
        />
      </button>
      {expanded && <div className="reasoning__body">{reasoning}</div>}
    </div>
  );
}

function ActionRow({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const streaming = useChatStore((s) => s.streaming);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.chunks.join(""));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard can be refused; the button simply doesn't confirm.
    }
  };

  const time = new Date(message.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="actions">
      <button
        type="button"
        className={`actions__btn${copied ? " actions__btn--active" : ""}`}
        onClick={() => void copy()}
        title={copied ? "已复制" : "复制"}
        aria-label={copied ? "已复制" : "复制"}
      >
        {copied ? <Icon.Check size={15} /> : <Icon.Copy size={15} />}
      </button>
      <button type="button" className="actions__btn" title="朗读" aria-label="朗读">
        <Icon.Speaker size={15} />
      </button>
      <button type="button" className="actions__btn" title="有帮助" aria-label="有帮助">
        <Icon.ThumbUp size={15} />
      </button>
      <button type="button" className="actions__btn" title="没帮助" aria-label="没帮助">
        <Icon.ThumbDown size={15} />
      </button>
      <button
        type="button"
        className="actions__btn"
        disabled={streaming}
        onClick={() => useChatStore.getState().regenerate()}
        title="重新生成"
        aria-label="重新生成"
      >
        <Icon.Regenerate size={15} />
      </button>
      <time className="actions__time">{time}</time>
    </div>
  );
}

/**
 * The agent mark that trails the newest reply.
 *
 * There is exactly one in the transcript and it belongs to the latest turn, so
 * older messages carry no avatar at all. When a reply completes, the action row
 * appears above the mark and pushes it down; a FLIP transition animates that
 * displacement, since it is caused by layout and cannot be transitioned
 * directly.
 */
function AgentMark({ settled }: { settled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const previousTop = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const top = element.getBoundingClientRect().top;
    const previous = previousTop.current;
    previousTop.current = top;

    if (previous === null || previous === top) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    element.style.transition = "none";
    element.style.transform = `translateY(${previous - top}px)`;
    // Flush so the browser sees two distinct states rather than collapsing them.
    void element.offsetWidth;
    element.style.transition = "transform 320ms cubic-bezier(.22,1,.36,1)";
    element.style.transform = "translateY(0)";
    // Only re-run when the reply settles — during streaming the mark should
    // track the growing text directly, not chase it with a 320ms lag.
  }, [settled]);

  return (
    <div className="mark" ref={ref}>
      <Icon.Mark size={22} />
    </div>
  );
}

export const Message = memo(function Message({
  message,
  isLatestAssistant,
}: MessageProps) {
  const text = message.chunks.join("");

  if (message.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble">{text}</div>
      </div>
    );
  }

  const streaming = message.status === "streaming";
  const empty = text.length === 0;

  return (
    <div className="msg msg--assistant">
      <ReasoningRow reasoning={message.reasoning} thinking={streaming && empty} />

      {streaming ? (
        <div className="prose prose--streaming">
          {message.chunks.map((chunk, index) => (
            // Chunks are append-only, so the index is a stable identity.
            <span className="chunk" key={index}>
              {chunk}
            </span>
          ))}
          <span className="caret" aria-hidden="true" />
        </div>
      ) : message.status === "cancelled" && empty ? (
        <div className="prose prose--muted">已停止</div>
      ) : (
        <div className="prose">
          {parseBlocks(text).map((block, index) =>
            block.kind === "code" ? (
              <pre className="code" key={index}>
                <code>{block.code}</code>
              </pre>
            ) : (
              <p className="para" key={index}>
                {block.text}
              </p>
            ),
          )}
        </div>
      )}

      {!streaming && !empty && <ActionRow message={message} />}
      {isLatestAssistant && <AgentMark settled={!streaming} />}
    </div>
  );
});
