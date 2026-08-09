import { describe, expect, it } from "vitest";

import { composeProfileBlock, EMPTY_PROFILE, MAX_ABOUT_CHARS } from "./profile";

describe("composeProfileBlock", () => {
  it("is the empty string when nothing is shared", () => {
    // Not a header with no body, not a placeholder — nothing. An empty block
    // would itself be information she was never given.
    expect(composeProfileBlock(EMPTY_PROFILE, "Asia/Shanghai")).toBe("");
  });

  it("a filled field stays private until its toggle says otherwise", () => {
    // The toggle is the consent, not the text box. Typing something and
    // leaving the switch off must send nothing.
    const block = composeProfileBlock(
      { ...EMPTY_PROFILE, callMe: "阿星", about: "喜欢打绝区零" },
      "Asia/Shanghai",
    );
    expect(block).toBe("");
  });

  it("a toggle with an empty field sends nothing either", () => {
    expect(
      composeProfileBlock({ ...EMPTY_PROFILE, callMeOn: true, callMe: "  " }, "UTC"),
    ).toBe("");
  });

  it("composes exactly what is switched on", () => {
    const block = composeProfileBlock(
      { callMe: "阿星", callMeOn: true, about: "", aboutOn: true, timezoneOn: true },
      "Asia/Shanghai",
    );
    expect(block).toContain("称呼对方：阿星");
    expect(block).toContain("Asia/Shanghai");
    // aboutOn with empty text contributes nothing.
    expect(block).not.toContain("希望你知道");
    expect(block.startsWith("[关于对方]")).toBe(true);
  });

  it("caps the free-form field", () => {
    const block = composeProfileBlock(
      { ...EMPTY_PROFILE, aboutOn: true, about: "多".repeat(MAX_ABOUT_CHARS + 200) },
      "UTC",
    );
    expect(block.length).toBeLessThan(MAX_ABOUT_CHARS + 60);
  });
});
