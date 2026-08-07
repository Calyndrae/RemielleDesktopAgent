import { describe, expect, it } from "vitest";

import {
  ambientBlock,
  canFire,
  DEFAULT_AMBIENT,
  EMPTY_AMBIENT_STATE,
  formatMinute,
  inQuietHours,
  localDay,
  muteToday,
  nextDelayMs,
  parseMinute,
  pickActivity,
  recordFired,
  rollDay,
  type AmbientSettings,
  type AmbientState,
} from "./ambient";

/** A local-time date, so the tests read the way the rules are written. */
const at = (day: string, hour: number, minute = 0) =>
  new Date(`${day}T${`${hour}`.padStart(2, "0")}:${`${minute}`.padStart(2, "0")}:00`);

const settings = (patch: Partial<AmbientSettings> = {}): AmbientSettings => ({
  ...DEFAULT_AMBIENT,
  ...patch,
});

const state = (patch: Partial<AmbientState> = {}): AmbientState => ({
  ...EMPTY_AMBIENT_STATE,
  ...patch,
});

describe("quiet hours", () => {
  it("covers a window that wraps midnight", () => {
    // The default, and the first thing anyone configures. A naive
    // `from <= t && t < to` gets every one of these backwards.
    const quiet = settings({ quietFrom: 22 * 60, quietTo: 8 * 60 });

    expect(inQuietHours(at("2026-08-06", 23), quiet)).toBe(true);
    expect(inQuietHours(at("2026-08-06", 3), quiet)).toBe(true);
    expect(inQuietHours(at("2026-08-06", 7, 59), quiet)).toBe(true);
    expect(inQuietHours(at("2026-08-06", 8), quiet)).toBe(false);
    expect(inQuietHours(at("2026-08-06", 14), quiet)).toBe(false);
    expect(inQuietHours(at("2026-08-06", 21, 59), quiet)).toBe(false);
    expect(inQuietHours(at("2026-08-06", 22), quiet)).toBe(true);
  });

  it("covers a window inside one day", () => {
    const quiet = settings({ quietFrom: 9 * 60, quietTo: 17 * 60 });

    expect(inQuietHours(at("2026-08-06", 12), quiet)).toBe(true);
    expect(inQuietHours(at("2026-08-06", 9), quiet)).toBe(true);
    expect(inQuietHours(at("2026-08-06", 17), quiet)).toBe(false);
    expect(inQuietHours(at("2026-08-06", 3), quiet)).toBe(false);
  });

  it("treats equal bounds as no quiet hours rather than all day", () => {
    const none = settings({ quietFrom: 0, quietTo: 0 });
    for (const hour of [0, 6, 12, 18, 23]) {
      expect(inQuietHours(at("2026-08-06", hour), none)).toBe(false);
    }
  });
});

describe("the daily counter", () => {
  it("rolls over when the calendar day changes", () => {
    const yesterday = state({ day: "2026-08-05", firedToday: 6 });
    const rolled = rollDay(yesterday, at("2026-08-06", 10));

    expect(rolled.day).toBe("2026-08-06");
    expect(rolled.firedToday).toBe(0);
  });

  it("leaves the count alone within the same day", () => {
    const today = state({ day: "2026-08-06", firedToday: 3 });
    expect(rollDay(today, at("2026-08-06", 23)).firedToday).toBe(3);
  });

  it("counts up as things happen", () => {
    let current = state({ day: "2026-08-06" });
    current = recordFired(current, at("2026-08-06", 10));
    current = recordFired(current, at("2026-08-06", 11));
    expect(current.firedToday).toBe(2);
  });

  it("starts the new day's count at one when the day turns mid-record", () => {
    const yesterday = state({ day: "2026-08-05", firedToday: 6 });
    const today = recordFired(yesterday, at("2026-08-06", 9));
    expect(today.firedToday).toBe(1);
  });
});

describe("blocking rules", () => {
  const awake = settings({ quietFrom: 0, quietTo: 0 });

  it("lets her act when nothing is in the way", () => {
    expect(canFire(state({ day: "2026-08-06" }), awake, at("2026-08-06", 14))).toBe(true);
    expect(ambientBlock(state({ day: "2026-08-06" }), awake, at("2026-08-06", 14))).toBe(
      null,
    );
  });

  it("names the rule that is holding her back", () => {
    // Settings can then say *why* she has been quiet, which a disabled toggle
    // cannot.
    expect(ambientBlock(state(), settings({ enabled: false }), at("2026-08-06", 14))).toBe(
      "off",
    );
    expect(ambientBlock(state(), DEFAULT_AMBIENT, at("2026-08-06", 2))).toBe("quiet");
    expect(
      ambientBlock(state({ day: "2026-08-06", firedToday: 6 }), awake, at("2026-08-06", 14)),
    ).toBe("capped");
  });

  it("honours 'not today' until the day actually turns", () => {
    const muted = muteToday(state({ day: "2026-08-06" }), at("2026-08-06", 14));

    expect(canFire(muted, awake, at("2026-08-06", 15))).toBe(false);
    expect(canFire(muted, awake, at("2026-08-06", 23, 59))).toBe(false);
    // Tomorrow it lapses on its own — the mute expires by going stale rather
    // than by needing anything to reset it.
    expect(canFire(muted, awake, at("2026-08-07", 9))).toBe(true);
  });

  it("still refuses when yesterday's count is at the cap but the day has turned", () => {
    // Guards the ordering inside `ambientBlock`: the cap must be checked
    // against the *rolled* count, not the stored one.
    const stale = state({ day: "2026-08-05", firedToday: 99 });
    expect(canFire(stale, awake, at("2026-08-06", 14))).toBe(true);
  });

  it("checks quiet hours before the cap", () => {
    // Both apply; the more informative answer is the one the user can act on
    // by looking at a clock.
    const capped = state({ day: "2026-08-06", firedToday: 99 });
    expect(ambientBlock(capped, DEFAULT_AMBIENT, at("2026-08-06", 2))).toBe("quiet");
  });
});

describe("timing", () => {
  it("stays inside the configured range", () => {
    const range = settings({ minMinutes: 45, maxMinutes: 120 });
    for (const roll of [0, 0.5, 1]) {
      const ms = nextDelayMs(range, () => roll);
      expect(ms).toBeGreaterThanOrEqual(45 * 60_000);
      expect(ms).toBeLessThanOrEqual(120 * 60_000);
    }
  });

  it("repairs reversed bounds instead of trusting them", () => {
    // These come from a file a user can edit by hand.
    const ms = nextDelayMs(settings({ minMinutes: 120, maxMinutes: 45 }), () => 0);
    expect(ms).toBe(45 * 60_000);
  });

  it("never returns a delay that would busy-loop the scheduler", () => {
    for (const broken of [
      settings({ minMinutes: 0, maxMinutes: 0 }),
      settings({ minMinutes: -30, maxMinutes: -5 }),
    ]) {
      expect(nextDelayMs(broken, () => 0)).toBeGreaterThan(0);
    }
  });
});

describe("what she does", () => {
  it("mostly just changes pose", () => {
    // Changing pose costs nothing and is what makes her feel present. Speaking
    // unprompted interrupts, and costs a request.
    expect(pickActivity(() => 0.9)).toBe("emote");
    expect(pickActivity(() => 0.3)).toBe("emote");
    expect(pickActivity(() => 0.1)).toBe("greeting");
  });
});

describe("clock formatting", () => {
  it("round-trips a time of day", () => {
    for (const minute of [0, 8 * 60, 22 * 60, 23 * 60 + 59]) {
      expect(parseMinute(formatMinute(minute))).toBe(minute);
    }
    expect(formatMinute(8 * 60)).toBe("08:00");
  });

  it("refuses input it cannot read rather than guessing", () => {
    for (const bad of ["", "8", "25:00", "12:60", "noon", "12-30"]) {
      expect(parseMinute(bad)).toBe(null);
    }
  });

  it("accepts a single-digit hour", () => {
    expect(parseMinute("8:30")).toBe(8 * 60 + 30);
  });
});

describe("local day", () => {
  it("uses the user's calendar, not UTC", () => {
    // 23:30 local is still today, whatever UTC thinks.
    expect(localDay(at("2026-08-06", 23, 30))).toBe("2026-08-06");
    expect(localDay(at("2026-08-06", 0, 1))).toBe("2026-08-06");
  });

  it("pads single-digit months and days", () => {
    expect(localDay(at("2026-01-02", 12))).toBe("2026-01-02");
  });
});
