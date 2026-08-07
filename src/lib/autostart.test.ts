import { beforeEach, describe, expect, it, vi } from "vitest";

const enable = vi.fn();
const disable = vi.fn();
const isEnabled = vi.fn();

vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: () => enable(),
  disable: () => disable(),
  isEnabled: () => isEnabled(),
}));

const { readAutostart, setAutostart } = await import("./autostart");

beforeEach(() => {
  enable.mockReset().mockResolvedValue(undefined);
  disable.mockReset().mockResolvedValue(undefined);
  isEnabled.mockReset().mockResolvedValue(false);
});

describe("readAutostart", () => {
  it("reports what the OS says", async () => {
    isEnabled.mockResolvedValue(true);
    expect(await readAutostart()).toBe(true);
  });

  it("reports false rather than throwing when the OS will not answer", async () => {
    // A settings window that refuses to open because a registry read failed is
    // worse than one showing an unchecked box.
    isEnabled.mockRejectedValue(new Error("access denied"));
    expect(await readAutostart()).toBe(false);
  });
});

describe("setAutostart", () => {
  it("enables and reports the state back", async () => {
    isEnabled.mockResolvedValue(true);
    expect(await setAutostart(true)).toBe(true);
    expect(enable).toHaveBeenCalledOnce();
    expect(disable).not.toHaveBeenCalled();
  });

  it("disables and reports the state back", async () => {
    isEnabled.mockResolvedValue(false);
    expect(await setAutostart(false)).toBe(false);
    expect(disable).toHaveBeenCalledOnce();
    expect(enable).not.toHaveBeenCalled();
  });

  it("returns what the OS actually did, not what was asked", async () => {
    // The whole point of the re-read. A managed machine can refuse the write
    // silently; returning the requested value would leave a ticked box standing
    // for a login item that does not exist.
    enable.mockResolvedValue(undefined);
    isEnabled.mockResolvedValue(false);

    expect(await setAutostart(true)).toBe(false);
  });

  it("still re-reads after the write throws", async () => {
    // A failed write may have partially applied. Guessing at that is precisely
    // what this function exists to avoid, so the answer still comes from the OS.
    enable.mockRejectedValue(new Error("refused"));
    isEnabled.mockResolvedValue(true);

    expect(await setAutostart(true)).toBe(true);
    expect(isEnabled).toHaveBeenCalledOnce();
  });

  it("survives both the write and the read failing", async () => {
    enable.mockRejectedValue(new Error("refused"));
    isEnabled.mockRejectedValue(new Error("also refused"));

    await expect(setAutostart(true)).resolves.toBe(false);
  });
});
