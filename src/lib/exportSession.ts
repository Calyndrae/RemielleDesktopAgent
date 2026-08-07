/**
 * Getting a conversation out of here and into something else.
 *
 * A companion that holds your conversation hostage is a worse companion. You
 * should be able to walk a thread over to ChatGPT, Claude, Gemini, a coding
 * agent, or a text file, without retyping it — so every transcript can leave in
 * three shapes, each aimed at a different destination:
 *
 * - `markdown`  — for reading, or pasting into anything at all.
 * - `json`      — full fidelity, including reasoning and tool use. This is the
 *                 only format that round-trips back into this app.
 * - `handoff`   — a single self-contained block written to be pasted as the
 *                 *first* message to a different assistant. It carries the
 *                 persona and the history and ends by handing over, so the new
 *                 assistant picks up mid-thread instead of starting over.
 */

import type { ChatMessage } from "@/state/chat";

export type ExportFormat = "markdown" | "json" | "handoff";

export interface ExportOptions {
  format: ExportFormat;
  /** The persona in force, so another assistant can keep the voice. */
  systemPrompt?: string;
  model?: string;
  provider?: string;
  /** Chain-of-thought is context, not content; off by default. */
  includeReasoning?: boolean;
}

/** Schema version for `json`. Bump when the shape changes incompatibly. */
export const SESSION_SCHEMA_VERSION = 1;

const text = (message: ChatMessage) => message.chunks.join("");

/** Messages worth exporting: failures and empty turns are noise. */
function usable(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.status !== "error" && text(m).trim().length > 0);
}

function timestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function toMarkdown(messages: ChatMessage[], options: ExportOptions): string {
  const lines: string[] = ["# 与蕾米埃尔的对话", ""];

  if (options.model) {
    lines.push(`> ${options.provider ?? ""} · ${options.model}`.trim(), "");
  }

  for (const message of usable(messages)) {
    lines.push(message.role === "user" ? "## 我" : "## 蕾米埃尔");

    if (options.includeReasoning && message.reasoning.trim()) {
      // Blockquoted so it reads as an aside rather than part of the answer.
      lines.push("", "> **思考过程**", ...message.reasoning.trim().split("\n").map((l) => `> ${l}`));
    }

    lines.push("", text(message).trim());

    const sources = message.tools.filter((t) => t.kind === "citation");
    if (sources.length > 0) {
      lines.push("", "**参考来源**");
      for (const source of sources) {
        if (source.kind === "citation") lines.push(`- [${source.title}](${source.url})`);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function toJson(messages: ChatMessage[], options: ExportOptions): string {
  return JSON.stringify(
    {
      schemaVersion: SESSION_SCHEMA_VERSION,
      exportedAt: timestamp(Date.now()),
      provider: options.provider ?? null,
      model: options.model ?? null,
      systemPrompt: options.systemPrompt ?? null,
      messages: usable(messages).map((message) => ({
        role: message.role,
        content: text(message),
        reasoning: message.reasoning || null,
        tools: message.tools,
        usage: message.usage,
        createdAt: timestamp(message.createdAt),
      })),
    },
    null,
    2,
  );
}

/**
 * One block to paste into a different assistant.
 *
 * Written as instructions *to that assistant*, not as a transcript dump — the
 * difference between it continuing the conversation and it summarising one.
 */
function toHandoff(messages: ChatMessage[], options: ExportOptions): string {
  const parts: string[] = [
    "以下是我和另一个助手进行到一半的对话。请接着往下聊，不要重新开始，也不要复述已经说过的内容。",
    "",
  ];

  if (options.systemPrompt?.trim()) {
    parts.push("【它被设定的角色】", options.systemPrompt.trim(), "");
  }

  parts.push("【已有对话】", "");
  for (const message of usable(messages)) {
    parts.push(`${message.role === "user" ? "我" : "助手"}：${text(message).trim()}`, "");
  }

  parts.push("【请从这里继续】");
  return parts.join("\n");
}

export function exportSession(messages: ChatMessage[], options: ExportOptions): string {
  switch (options.format) {
    case "markdown":
      return toMarkdown(messages, options);
    case "json":
      return toJson(messages, options);
    case "handoff":
      return toHandoff(messages, options);
  }
}

/** Suggested filename, safe on Windows. */
export function exportFilename(format: ExportFormat, at = new Date()): string {
  const stamp = at.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const extension = format === "json" ? "json" : format === "markdown" ? "md" : "txt";
  return `remielle-${stamp}.${extension}`;
}

/** Parses a previously exported `json` session back into messages. */
export function importSession(raw: string): {
  messages: Omit<ChatMessage, "id">[];
  systemPrompt: string | null;
  model: string | null;
} {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const version = parsed["schemaVersion"];
  if (typeof version !== "number" || version > SESSION_SCHEMA_VERSION) {
    throw new Error(
      `这个存档来自更新的版本（schema ${String(version)}），当前版本读不了。`,
    );
  }

  const rows = Array.isArray(parsed["messages"]) ? parsed["messages"] : [];

  return {
    systemPrompt: typeof parsed["systemPrompt"] === "string" ? parsed["systemPrompt"] : null,
    model: typeof parsed["model"] === "string" ? parsed["model"] : null,
    messages: rows.flatMap((row): Omit<ChatMessage, "id">[] => {
      if (typeof row !== "object" || row === null) return [];
      const item = row as Record<string, unknown>;
      const role = item["role"];
      const content = item["content"];
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") return [];

      const at = typeof item["createdAt"] === "string" ? Date.parse(item["createdAt"]) : NaN;

      return [
        {
          role,
          chunks: [content],
          reasoning: typeof item["reasoning"] === "string" ? item["reasoning"] : "",
          tools: Array.isArray(item["tools"]) ? (item["tools"] as ChatMessage["tools"]) : [],
          // Tool runs are not restored: they describe things that already
          // happened to a machine, and replaying them into a resumed transcript
          // would claim they happened again.
          toolRuns: [],
          usage: null,
          error: null,
          status: "done",
          // A hand-edited or foreign file may carry no usable timestamp.
          createdAt: Number.isFinite(at) ? at : Date.now(),
        },
      ];
    }),
  };
}
