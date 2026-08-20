import { memo, useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { describeError, type ApiError, type ToolActivity } from "@/lib/ipc";
import { useMessages } from "@/i18n/useLocale";
import { Prose } from "./Prose";
import {
  reasoningSummary,
  useChatStore,
  type ChatMessage,
  type ToolRun,
} from "@/state/chat";
import { Icon } from "./icons";

interface MessageProps {
  message: ChatMessage;
  /** The newest assistant turn carries the agent mark and the action row. */
  isLatestAssistant: boolean;
}

/** Strips the scheme and any `www.`, leaving the part worth reading. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Everything that happened before the answer, on one line.
 *
 * Web searches and chain-of-thought are both provenance, and both used to get a
 * row of their own: two muted lines of identical shape, each with its own
 * chevron, stacked four pixels apart above every reply. They read as one widget
 * accidentally rendered twice.
 *
 * One strip, two toggles, one panel open at a time. Neither can be silently
 * dropped — "did it search the web, and what did it read?" and "what was it
 * thinking?" both have to be answerable by looking at the transcript.
 */
function MetaStrip({
  tools,
  toolRuns,
  reasoning,
  thinking,
}: {
  tools: ToolActivity[];
  toolRuns: ToolRun[];
  reasoning: string;
  thinking: boolean;
}) {
  const m = useMessages();
  const [open, setOpen] = useState<"tools" | "reasoning" | null>(null);

  const queries = tools.filter((t) => t.kind === "search");
  const sources = tools.filter((t) => t.kind === "citation");
  const hasTools = tools.length > 0;

  if (!hasTools && !reasoning && !thinking && toolRuns.length === 0) return null;

  const toggle = (which: "tools" | "reasoning") =>
    setOpen((current) => (current === which ? null : which));

  return (
    <div className="meta">
      <div className="meta__strip">
        {hasTools && (
          <button
            type="button"
            className={`meta__tab${open === "tools" ? " meta__tab--open" : ""}`}
            onClick={() => toggle("tools")}
            aria-expanded={open === "tools"}
            disabled={sources.length === 0}
            title={queries.map((q) => q.query).join("、") || undefined}
          >
            <Icon.Globe size={13} className="meta__icon" />
            <span className="meta__label">
              {queries.length > 0 ? m.chat.searchedWeb : m.chat.referencedPages}
            </span>
            {sources.length > 0 && <span className="meta__count">{sources.length}</span>}
          </button>
        )}

        {(reasoning || thinking) && (
          <button
            type="button"
            className={`meta__tab${open === "reasoning" ? " meta__tab--open" : ""}${
              thinking ? " meta__tab--pulsing" : ""
            }`}
            onClick={() => toggle("reasoning")}
            aria-expanded={open === "reasoning"}
            disabled={!reasoning}
            // The gist without expanding, for anyone who hovers.
            title={reasoning ? reasoningSummary(reasoning) : undefined}
          >
            <span className="meta__label">
              {thinking ? m.chat.thinking : m.chat.thoughtProcess}
            </span>
          </button>
        )}
      </div>

      {open === "tools" && (
        <ul className="sources">
          {sources.map((source, index) => (
            <li key={`${source.url}-${index}`}>
              <button
                type="button"
                className="sources__link"
                onClick={() => void openUrl(source.url)}
                title={source.url}
              >
                <span className="sources__title">{source.title}</span>
                <span className="sources__host">{hostOf(source.url)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open === "reasoning" && reasoning && (
        <div className="meta__body">{reasoning}</div>
      )}

      {/*
        What she did to the machine, always visible — never behind a toggle.
        A search she ran is context; a setting she changed is a consequence, and
        the user finding out about it only if they think to expand a row is the
        thing this whole design exists to prevent. Refusals are listed too: "she
        tried and was stopped" is as important as "she did it".
      */}
      {toolRuns.length > 0 && (
        <ul className="runs">
          {toolRuns.map((run) => (
            <li
              key={run.callId}
              className={`run${run.ok === false ? " run--refused" : ""}${
                run.ok === null ? " run--pending" : ""
              }`}
            >
              <span className="run__dot" aria-hidden="true" />
              <span className="run__text">{run.summary ?? `${run.label}…`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A failed turn, with the specific remedy rather than "something went wrong". */
function ErrorRow({ error }: { error: ApiError }) {
  const m = useMessages();
  const { title, hint } = describeError(error, m);
  return (
    <div className="turn-error">
      <p className="turn-error__title">{title}</p>
      {hint && <p className="turn-error__hint">{hint}</p>}
      <button
        type="button"
        className="turn-error__retry"
        onClick={() => useChatStore.getState().regenerate()}
      >
        {m.chat.retryTurn}
      </button>
    </div>
  );
}

function ActionRow({ message }: { message: ChatMessage }) {
  const m = useMessages();
  const [copied, setCopied] = useState(false);
  const streaming = useChatStore((s) => s.streaming);
  const text = message.chunks.join("");

  /*
   * Per-reply cost, but only once it says something the header doesn't.
   *
   * The header carries the running session total. On the first reply the two
   * numbers are identical, so printing both put "224 tok" twice on one small
   * panel — which reads as a rendering fault, not as two different facts.
   */
  const replies = useChatStore(
    (s) => s.messages.filter((m) => m.role === "assistant" && m.usage).length,
  );
  const showTokens = message.usage !== null && replies > 1;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard can be refused; the button simply doesn't confirm.
    }
  };

  // `hour12: false` rather than the locale default: the row is a dense line of
  // metadata and "01:40 AM" is four characters wider than "01:40" for nothing.
  const time = new Date(message.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <div className="actions">
      <button
        type="button"
        className={`actions__btn${copied ? " actions__btn--active" : ""}`}
        onClick={() => void copy()}
        title={copied ? m.chat.copied : m.chat.copy}
        aria-label={copied ? m.chat.copied : m.chat.copy}
      >
        {copied ? <Icon.Check size={15} /> : <Icon.Copy size={15} />}
      </button>
      <button
        type="button"
        className="actions__btn"
        disabled={streaming}
        onClick={() => useChatStore.getState().regenerate()}
        title={m.chat.regenerate}
        aria-label={m.chat.regenerate}
      >
        <Icon.Regenerate size={15} />
      </button>
      {showTokens && message.usage && (
        <span
          className="actions__tokens"
          title={m.chat.messageUsage(message.usage.prompt, message.usage.completion)}
        >
          {message.usage.total} tok
        </span>
      )}
      <time className="actions__time">{time}</time>
    </div>
  );
}

/**
 * The agent mark that trails the newest reply.
 *
 * There is exactly one in the transcript and it belongs to the latest turn, so
 * older messages carry no avatar at all.
 *
 * While the reply streams it sits alone under the growing text, like a nib. On
 * completion the action row appears *before* it on the same line, so the mark
 * slides across to the end of the row and comes to rest as a signature. It used
 * to end up on a line of its own below the actions, which read as a stray glyph
 * in dead space rather than a resting place.
 *
 * The displacement is caused by layout and so cannot be transitioned directly;
 * a FLIP measures it and plays it back.
 */
function AgentMark({ settled }: { settled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const box = element.getBoundingClientRect();
    const from = previous.current;
    previous.current = { x: box.left, y: box.top };

    if (!from || (from.x === box.left && from.y === box.top)) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    element.style.transition = "none";
    element.style.transform = `translate(${from.x - box.left}px, ${from.y - box.top}px)`;
    // Flush so the browser sees two distinct states rather than collapsing them.
    void element.offsetWidth;
    element.style.transition = "transform 320ms cubic-bezier(.22,1,.36,1)";
    element.style.transform = "translate(0, 0)";
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
  const m = useMessages();
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
  const showActions = !streaming && !empty && !message.error;

  return (
    <div className="msg msg--assistant">
      <MetaStrip
        tools={message.tools}
        toolRuns={message.toolRuns}
        reasoning={message.reasoning}
        thinking={streaming && empty}
      />

      {message.error ? (
        <ErrorRow error={message.error} />
      ) : message.status === "cancelled" && empty ? (
        <div className="prose prose--muted">{m.chat.stopped}</div>
      ) : (
        /*
         * One renderer for streaming and settled text. Re-parsing the whole
         * reply per chunk is cheap at chat sizes, and the alternative — plain
         * chunks while streaming, markdown after — made every reply visibly
         * re-typeset itself at the moment it finished.
         */
        <Prose text={text} tools={message.tools} streaming={streaming} />
      )}

      {/*
        One footer line for the turn. The mark keeps its DOM position across the
        transition so its FLIP has something to measure; the action row is what
        appears beside it.
      */}
      {(showActions || isLatestAssistant) && (
        <div className={`turnfoot${isLatestAssistant ? "" : " turnfoot--quiet"}`}>
          {showActions && <ActionRow message={message} />}
          {isLatestAssistant && <AgentMark settled={!streaming} />}
        </div>
      )}
    </div>
  );
});
