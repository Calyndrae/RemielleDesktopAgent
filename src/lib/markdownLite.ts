/**
 * Minimal block splitter: fenced code blocks versus everything else.
 *
 * Not a Markdown implementation and not trying to be. What M1 needs is for code
 * to land in an element that can scroll horizontally on its own, because a long
 * line of code is the single most reliable way to burst a flex layout. Richer
 * formatting arrives with the real message renderer.
 */

export type Block =
  | { kind: "code"; lang: string; code: string }
  | { kind: "text"; text: string };

/** ```lang\n ... \n``` — the closing fence is optional so a stream mid-block still renders. */
const FENCE = /```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;

export function parseBlocks(input: string): Block[] {
  const blocks: Block[] = [];
  let cursor = 0;

  FENCE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FENCE.exec(input)) !== null) {
    if (match.index > cursor) {
      pushText(blocks, input.slice(cursor, match.index));
    }

    blocks.push({
      kind: "code",
      lang: match[1] ?? "",
      // Trailing newline before the closing fence is part of the fence syntax,
      // not the code.
      code: (match[2] ?? "").replace(/\r?\n$/, ""),
    });

    cursor = match.index + match[0].length;

    // A zero-length match would spin forever; defensive but cheap.
    if (match[0].length === 0) FENCE.lastIndex += 1;
  }

  if (cursor < input.length) {
    pushText(blocks, input.slice(cursor));
  }

  return blocks;
}

function pushText(blocks: Block[], text: string): void {
  // Drop segments that are only the whitespace separating two fences.
  if (text.trim().length === 0) return;

  // Strip the newlines that merely separate a fence from its neighbours.
  // Text renders with `white-space: pre-wrap`, so leaving them would stack a
  // blank line on top of the block's own margin. Only newline runs at the very
  // edges go — interior blank lines are the author's paragraph breaks, and
  // leading indentation on the first real line is preserved.
  blocks.push({ kind: "text", text: text.replace(/^\n+/, "").replace(/\n+$/, "") });
}
