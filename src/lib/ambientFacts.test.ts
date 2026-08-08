import { describe, expect, it } from "vitest";

import { buildFacts, firstTodayPhrase, idlePhrase, partOfDay } from "./ambientFacts";

const at = (hour: number) => new Date(2026, 7, 8, hour, 30);

describe("partOfDay", () => {
  it("covers the whole clock with no gap", () => {
    // A gap would mean some hour of the day produces nothing, and the first
    // fact is the one that is always present.
    for (let hour = 0; hour < 24; hour += 1) {
      expect(partOfDay(new Date(2026, 7, 8, hour))).toBeTruthy();
    }
  });

  it("names the part of the day rather than the time", () => {
    // Deliberate: a model handed "14:37" tends to read it back, which is a
    // clock, not a remark.
    expect(partOfDay(at(2))).toContain("深夜");
    expect(partOfDay(at(10))).toContain("上午");
    expect(partOfDay(at(20))).toContain("晚上");
    expect(partOfDay(at(10))).not.toMatch(/\d/);
  });
});

describe("idlePhrase", () => {
  it("says nothing about a short pause", () => {
    // Thinking for two minutes is not absence, and mentioning it would make her
    // sound like she is timing you.
    expect(idlePhrase(0)).toBeNull();
    expect(idlePhrase(4 * 60_000)).toBeNull();
  });

  it("gets vaguer as the gap grows", () => {
    expect(idlePhrase(12 * 60_000)).toContain("12");
    expect(idlePhrase(45 * 60_000)).not.toMatch(/\d/);
    expect(idlePhrase(3 * 60 * 60_000)).toContain("3");
  });
});

describe("firstTodayPhrase", () => {
  it("only fires on the first one", () => {
    expect(firstTodayPhrase(0)).toBeTruthy();
    expect(firstTodayPhrase(1)).toBeNull();
  });
});

describe("buildFacts", () => {
  const base = { now: at(10), idleMs: 0, firedToday: 3, activeApp: null };

  it("always has at least the time of day", () => {
    expect(buildFacts(base)).toHaveLength(1);
  });

  it("leaves out the active app unless one was supplied", () => {
    // The absence here is the privacy contract: the caller only fills this in
    // when `get_active_window` is switched on, so a null must produce silence
    // rather than a placeholder.
    expect(buildFacts(base).join()).not.toContain("正开着");
    expect(buildFacts({ ...base, activeApp: "Blender" }).join()).toContain("Blender");
  });

  it("collects everything that applies", () => {
    const facts = buildFacts({
      now: at(23),
      idleMs: 40 * 60_000,
      firedToday: 0,
      activeApp: "Visual Studio Code",
    });
    expect(facts).toHaveLength(4);
    expect(facts.join()).toContain("Visual Studio Code");
  });

  it("produces statements, never a finished sentence", () => {
    // If this file ever starts emitting something that reads as her voice, the
    // generation step has been quietly replaced by a template.
    for (const fact of buildFacts({ ...base, idleMs: 40 * 60_000, firedToday: 0 })) {
      expect(fact).not.toContain("呢~");
      expect(fact).not.toMatch(/[?？]/);
    }
  });
});
