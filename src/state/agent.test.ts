import { describe, expect, it } from "vitest";
import { resolveAnimation } from "./agent";
import type { PackAnimation, PackManifest } from "@/types/pack";

function animation(id: string): PackAnimation {
  return {
    id,
    label: {},
    file: `${id}.gif`,
    offset: { x: 0, y: 0 },
    path: `/packs/test/${id}.gif`,
    selectable: true,
  };
}

function pack(states: Record<string, string>, ids = ["idle", "thinking", "writing"]): PackManifest {
  return {
    id: "test",
    name: "Test",
    license: "",
    credits: [],
    frameSize: { width: 300, height: 300 },
    animations: ids.map(animation),
    states,
  };
}

const FULL = pack({ idle: "idle", thinking: "thinking", writing: "writing" });

describe("resolveAnimation", () => {
  it("maps a state to its animation", () => {
    expect(resolveAnimation(FULL, "thinking", null)?.id).toBe("thinking");
  });

  it("prefers an explicit emote override", () => {
    expect(resolveAnimation(FULL, "thinking", "writing")?.id).toBe("writing");
  });

  it("ignores an override naming an animation the pack lacks", () => {
    // A stale `/emote change` target must not blank the character.
    expect(resolveAnimation(FULL, "thinking", "nonexistent")?.id).toBe("thinking");
  });

  it("falls back when an optional state is unmapped", () => {
    // penIdle -> idle, writingPaused -> writing.
    expect(resolveAnimation(FULL, "penIdle", null)?.id).toBe("idle");
    expect(resolveAnimation(FULL, "writingPaused", null)?.id).toBe("writing");
  });

  it("falls back to idle for states with no mapping or usable fallback", () => {
    expect(resolveAnimation(FULL, "pleased", null)?.id).toBe("idle");
    expect(resolveAnimation(FULL, "confused", null)?.id).toBe("idle");
  });

  it("uses the first animation when even idle is unmapped", () => {
    const broken = pack({ writing: "writing" });
    // Nothing resolves through the mapping, but the character still has to be
    // drawn — an invisible sprite reads as a crash to the user.
    expect(resolveAnimation(broken, "thinking", null)?.id).toBe("idle");
  });

  it("returns null only when the pack has no animations at all", () => {
    const empty: PackManifest = { ...pack({}), animations: [] };
    expect(resolveAnimation(empty, "idle", null)).toBeNull();
  });
});
