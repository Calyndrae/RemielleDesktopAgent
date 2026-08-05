import { describe, expect, it } from "vitest";
import { parseBlocks } from "./markdownLite";

describe("parseBlocks", () => {
  it("returns a single text block for plain prose", () => {
    expect(parseBlocks("just some text")).toEqual([
      { kind: "text", text: "just some text" },
    ]);
  });

  it("extracts a fenced block with its language", () => {
    const blocks = parseBlocks("before\n```ts\nconst a = 1;\n```\nafter");
    expect(blocks).toEqual([
      { kind: "text", text: "before" },
      { kind: "code", lang: "ts", code: "const a = 1;" },
      { kind: "text", text: "after" },
    ]);
  });

  it("strips only the newlines adjoining a fence", () => {
    // Interior blank lines are paragraph breaks and must survive; the ones
    // touching the fence are separators and would double the visual gap.
    const blocks = parseBlocks("a\n\nb\n\n```\ncode\n```\n\n\nc");
    expect(blocks[0]).toEqual({ kind: "text", text: "a\n\nb" });
    expect(blocks[2]).toEqual({ kind: "text", text: "c" });
  });

  it("handles a fence with no language", () => {
    const blocks = parseBlocks("```\nplain\n```");
    expect(blocks).toEqual([{ kind: "code", lang: "", code: "plain" }]);
  });

  it("closes an unterminated fence at end of input", () => {
    // Mid-stream the closing fence has not arrived yet; the block still has to
    // render rather than vanishing into a text run.
    const blocks = parseBlocks("intro\n```py\nx = 1\ny = 2");
    expect(blocks).toEqual([
      { kind: "text", text: "intro" },
      { kind: "code", lang: "py", code: "x = 1\ny = 2" },
    ]);
  });

  it("keeps multiple fences separate", () => {
    const blocks = parseBlocks("```a\n1\n```\n\n```b\n2\n```");
    expect(blocks).toEqual([
      { kind: "code", lang: "a", code: "1" },
      { kind: "code", lang: "b", code: "2" },
    ]);
  });

  it("drops whitespace-only gaps between fences", () => {
    const blocks = parseBlocks("```a\n1\n```\n   \n```b\n2\n```");
    expect(blocks.every((b) => b.kind === "code")).toBe(true);
  });

  it("preserves blank lines inside code", () => {
    const blocks = parseBlocks("```\na\n\nb\n```");
    expect(blocks[0]).toEqual({ kind: "code", lang: "", code: "a\n\nb" });
  });

  it("tolerates CRLF line endings", () => {
    const blocks = parseBlocks("```ts\r\nconst a = 1;\r\n```");
    expect(blocks[0]).toEqual({ kind: "code", lang: "ts", code: "const a = 1;" });
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("   \n  ")).toEqual([]);
  });

  it("is reusable across calls despite the module-level regex", () => {
    // A global regex carries `lastIndex`; resetting it is what keeps repeated
    // calls from silently skipping the first fence.
    const input = "```ts\na\n```";
    expect(parseBlocks(input)).toEqual(parseBlocks(input));
  });
});
