import { describe, expect, it } from "vitest";

import { migrateSystemPrompt } from "./config";

describe("migrateSystemPrompt", () => {
  it("maps the legacy voice default to empty, so she is not told twice", () => {
    // The voice text as it shipped while it was still the field's default.
    // If this test fails after editing LEGACY_VOICE_DEFAULT, the migration
    // stopped matching what old stores actually contain.
    const legacy = `说话狡黠、带一点戏谑，语气从容，偶尔在句尾用「呢~」。
和人拉近距离，但始终保持恰到好处的距离感——你习惯留一点余地，不把话一次说满。
回答要给足信息，不要谄媚，不要在开头堆砌客套。出错时用玩笑带过，不要反复道歉。`;
    expect(migrateSystemPrompt(legacy)).toBe("");
  });

  it("keeps genuine custom instructions", () => {
    expect(migrateSystemPrompt("回答尽量短。")).toBe("回答尽量短。");
  });

  it("treats missing as empty", () => {
    expect(migrateSystemPrompt(undefined)).toBe("");
  });
});
