import { memo } from "react";

import { parseBlocks } from "@/lib/markdownLite";
import type { ChatMessage } from "@/state/chat";

interface MessageProps {
  message: ChatMessage;
}

/**
 * A single turn.
 *
 * User turns are plain right-aligned bubbles with no avatar — deliberately, so
 * the only agent mark in the transcript is the one that follows the newest
 * reply.
 *
 * Assistant turns render in two modes. While streaming, each arrived chunk is
 * its own span so it can fade in from blur independently; joining them first
 * would restart the animation on the whole message every update. Once the reply
 * is complete the chunks are joined and re-rendered as blocks, which is what
 * gives code its own horizontally scrollable element.
 */
export const Message = memo(function Message({ message }: MessageProps) {
  const text = message.chunks.join("");

  if (message.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble">{text}</div>
      </div>
    );
  }

  if (message.status === "streaming") {
    return (
      <div className="msg msg--assistant">
        <div className="prose prose--streaming">
          {message.chunks.map((chunk, index) => (
            // Chunks are append-only, so the index is a stable identity.
            <span className="chunk" key={index}>
              {chunk}
            </span>
          ))}
          <span className="caret" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (message.status === "cancelled" && text.length === 0) {
    return (
      <div className="msg msg--assistant">
        <div className="prose prose--muted">已停止</div>
      </div>
    );
  }

  return (
    <div className="msg msg--assistant">
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
    </div>
  );
});
