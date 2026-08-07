import { describe, expect, it } from "vitest";
import {
  exportFilename,
  exportSession,
  importSession,
  SESSION_SCHEMA_VERSION,
} from "./exportSession";
import type { ChatMessage } from "@/state/chat";

function message(
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `${role}-${content.slice(0, 4)}`,
    role,
    chunks: [content],
    reasoning: "",
    tools: [],
    toolRuns: [],
    usage: null,
    error: null,
    status: "done",
    createdAt: Date.parse("2026-08-06T12:00:00Z"),
    ...extra,
  };
}

const THREAD: ChatMessage[] = [
  message("user", "帮我看看这段代码"),
  message("assistant", "问题在窗口还没显示就改属性了。", {
    reasoning: "先判断调用时机。",
    tools: [{ kind: "citation", title: "Tauri docs", url: "https://v2.tauri.app" }],
  }),
];

describe("markdown export", () => {
  it("includes both turns as readable prose", () => {
    const out = exportSession(THREAD, { format: "markdown" });
    expect(out).toContain("## 我");
    expect(out).toContain("帮我看看这段代码");
    expect(out).toContain("## 蕾米埃尔");
  });

  it("omits reasoning unless asked", () => {
    // Chain-of-thought is context, not content — it should not leak into a
    // transcript someone pastes somewhere public by default.
    expect(exportSession(THREAD, { format: "markdown" })).not.toContain("先判断调用时机");
    expect(
      exportSession(THREAD, { format: "markdown", includeReasoning: true }),
    ).toContain("先判断调用时机");
  });

  it("lists cited sources as links", () => {
    expect(exportSession(THREAD, { format: "markdown" })).toContain(
      "[Tauri docs](https://v2.tauri.app)",
    );
  });

  it("drops failed and empty turns", () => {
    const noisy = [
      ...THREAD,
      message("assistant", "", { status: "cancelled" }),
      message("assistant", "boom", { status: "error" }),
    ];
    const out = exportSession(noisy, { format: "markdown" });
    expect(out).not.toContain("boom");
  });
});

describe("handoff export", () => {
  it("instructs the receiving assistant to continue rather than restart", () => {
    const out = exportSession(THREAD, { format: "handoff" });
    expect(out).toContain("请接着往下聊");
    expect(out).toContain("【请从这里继续】");
  });

  it("carries the persona so the voice survives the move", () => {
    const out = exportSession(THREAD, {
      format: "handoff",
      systemPrompt: "你是蕾米埃尔。",
    });
    expect(out).toContain("你是蕾米埃尔。");
  });

  it("omits the persona section entirely when there is none", () => {
    expect(exportSession(THREAD, { format: "handoff" })).not.toContain("被设定的角色");
  });
});

describe("json round trip", () => {
  it("restores content, roles and reasoning", () => {
    const raw = exportSession(THREAD, {
      format: "json",
      systemPrompt: "persona",
      model: "deepseek-reasoner",
    });
    const back = importSession(raw);

    expect(back.systemPrompt).toBe("persona");
    expect(back.model).toBe("deepseek-reasoner");
    expect(back.messages).toHaveLength(2);
    expect(back.messages[0]!.role).toBe("user");
    expect(back.messages[0]!.chunks.join("")).toBe("帮我看看这段代码");
    expect(back.messages[1]!.reasoning).toBe("先判断调用时机。");
  });

  it("preserves timestamps across the round trip", () => {
    const back = importSession(exportSession(THREAD, { format: "json" }));
    expect(back.messages[0]!.createdAt).toBe(Date.parse("2026-08-06T12:00:00Z"));
  });

  it("refuses an archive from a newer schema instead of mangling it", () => {
    const future = JSON.stringify({ schemaVersion: 999, messages: [] });
    expect(() => importSession(future)).toThrow(/读不了/);
  });

  it("skips malformed rows rather than failing the whole import", () => {
    // A hand-edited file should still yield whatever is salvageable.
    const raw = JSON.stringify({
      schemaVersion: SESSION_SCHEMA_VERSION,
      messages: [
        { role: "user", content: "ok" },
        { role: "wizard", content: "not a role" },
        { content: "no role at all" },
        null,
      ],
    });
    const back = importSession(raw);
    expect(back.messages).toHaveLength(1);
    expect(back.messages[0]!.chunks.join("")).toBe("ok");
  });

  it("substitutes a timestamp when the archive has none", () => {
    const raw = JSON.stringify({
      schemaVersion: SESSION_SCHEMA_VERSION,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(Number.isFinite(importSession(raw).messages[0]!.createdAt)).toBe(true);
  });
});

describe("exportFilename", () => {
  it("uses an extension matching the format", () => {
    const at = new Date("2026-08-06T12:34:00Z");
    expect(exportFilename("json", at)).toMatch(/\.json$/);
    expect(exportFilename("markdown", at)).toMatch(/\.md$/);
    expect(exportFilename("handoff", at)).toMatch(/\.txt$/);
  });

  it("contains no characters Windows rejects in a filename", () => {
    const name = exportFilename("markdown", new Date("2026-08-06T12:34:00Z"));
    expect(name).not.toMatch(/[:<>"/\\|?*]/);
  });
});
