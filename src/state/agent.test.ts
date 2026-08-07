import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ambientEmotePool,
  cancelPendingState,
  MIN_DWELL_MS,
  restingState,
  useAgentStore,
} from "./agent";

beforeEach(() => {
  vi.useFakeTimers();
  cancelPendingState();
  useAgentStore.setState({ state: "idle", emoteOverride: null, ambientSuspended: false });
  // Push past the dwell floor so each test starts able to transition at once.
  vi.advanceTimersByTime(MIN_DWELL_MS * 2);
});

afterEach(() => {
  cancelPendingState();
  vi.useRealTimers();
});

describe("resting state", () => {
  it("has no separate 'finished' pose", () => {
    // A reply completing is the absence of an activity. With the panel open she
    // returns to the pen; with it closed, to the desktop idle. Nothing in
    // between, and nothing on a timer.
    expect(restingState(true)).toBe("penIdle");
    expect(restingState(false)).toBe("idle");
  });
});

describe("minimum dwell", () => {
  it("applies the first change immediately", () => {
    useAgentStore.getState().setState("thinking");
    expect(useAgentStore.getState().state).toBe("thinking");
  });

  it("holds a state that has only just been entered", () => {
    useAgentStore.getState().setState("thinking");

    // A fast model can start emitting text almost at once. Switching now would
    // show a single frame of the thinking pose and throw it away.
    vi.advanceTimersByTime(100);
    useAgentStore.getState().setState("writing");
    expect(useAgentStore.getState().state).toBe("thinking");

    vi.advanceTimersByTime(MIN_DWELL_MS);
    expect(useAgentStore.getState().state).toBe("writing");
  });

  it("changes at once when the current state is already old enough", () => {
    useAgentStore.getState().setState("thinking");
    vi.advanceTimersByTime(MIN_DWELL_MS + 50);

    useAgentStore.getState().setState("writing");
    expect(useAgentStore.getState().state).toBe("writing");
  });

  it("keeps only the newest request when several arrive inside the floor", () => {
    useAgentStore.getState().setState("thinking");
    vi.advanceTimersByTime(50);

    useAgentStore.getState().setState("writing");
    useAgentStore.getState().setState("penIdle");

    vi.advanceTimersByTime(MIN_DWELL_MS);
    // "writing" must not surface on the way through: a queued state that has
    // been superseded never happened.
    expect(useAgentStore.getState().state).toBe("penIdle");
  });

  it("ignores a request for the state it is already in", () => {
    useAgentStore.getState().setState("thinking");
    vi.advanceTimersByTime(10);

    useAgentStore.getState().setState("thinking");
    vi.advanceTimersByTime(MIN_DWELL_MS * 2);
    expect(useAgentStore.getState().state).toBe("thinking");
  });

  it("drops a pending change when cancelled", () => {
    useAgentStore.getState().setState("thinking");
    vi.advanceTimersByTime(50);
    useAgentStore.getState().setState("writing");

    cancelPendingState();
    vi.advanceTimersByTime(MIN_DWELL_MS * 2);
    expect(useAgentStore.getState().state).toBe("thinking");
  });

  it("clears a manual emote when the state commits, not when it is requested", () => {
    useAgentStore.getState().setState("thinking");
    useAgentStore.getState().setEmoteOverride("得意");
    vi.advanceTimersByTime(50);

    // Held by the floor, so `/emote change` is still what she is showing.
    useAgentStore.getState().setState("writing");
    expect(useAgentStore.getState().emoteOverride).toBe("得意");

    vi.advanceTimersByTime(MIN_DWELL_MS);
    expect(useAgentStore.getState().state).toBe("writing");
    expect(useAgentStore.getState().emoteOverride).toBe(null);
  });
});

describe("ambient scheduling", () => {
  it("runs by default", () => {
    expect(useAgentStore.getState().canRunAmbient()).toBe(true);
  });

  it("stops while suspended, and the current animation is left alone", () => {
    useAgentStore.getState().setEmoteOverride("得意");
    useAgentStore.getState().suspendAmbient(true);

    expect(useAgentStore.getState().canRunAmbient()).toBe(false);
    // Suspending pauses the scheduler; it does not reset what she is doing.
    expect(useAgentStore.getState().emoteOverride).toBe("得意");
  });

  it("resumes", () => {
    useAgentStore.getState().suspendAmbient(true);
    useAgentStore.getState().suspendAmbient(false);
    expect(useAgentStore.getState().canRunAmbient()).toBe(true);
  });
});

describe("the pool the idle scheduler picks from", () => {
  /** The shipped pack's shape, which is what the rule was written against. */
  const pack = {
    id: "p",
    name: "P",
    license: "",
    credits: [],
    frameSize: { width: 302, height: 298 },
    states: {
      idle: "idle",
      penIdle: "pen_idle",
      thinking: "thinking",
      writing: "writing_continuous",
      writingPaused: "writing_intermittent",
      expect: "expect",
      pleased: "pleased",
      confused: "expect",
    },
    animations: [
      "idle",
      "pen_idle",
      "thinking",
      "writing_continuous",
      "writing_intermittent",
      "expect",
      "pleased",
    ].map((id) => ({
      id,
      label: {},
      file: `${id}.gif`,
      offset: { x: 0, y: 0 },
      size: { width: 300, height: 300 },
      path: `/${id}.gif`,
      selectable: true,
    })),
  };

  it("never offers a pose that claims she is working", () => {
    // The whole point. Drawing means "writing you a reply"; the pen idle means
    // "the chat is open". Playing either at random is a claim the user has no
    // way to see through — and the scheduler fires 45 to 120 minutes apart, so
    // she would stand there mid-brushstroke for the entire gap.
    const ids = ambientEmotePool(pack).map((a) => a.id);

    expect(ids).not.toContain("writing_continuous");
    expect(ids).not.toContain("writing_intermittent");
    expect(ids).not.toContain("thinking");
    expect(ids).not.toContain("pen_idle");
  });

  it("does not offer idle either, because idle is the baseline", () => {
    expect(ambientEmotePool(pack).map((a) => a.id)).not.toContain("idle");
  });

  it("leaves the poses that mean nothing in particular", () => {
    expect(ambientEmotePool(pack).map((a) => a.id).sort()).toEqual([
      "expect",
      "pleased",
    ]);
  });

  it("returns nothing rather than a lie when a pack maps everything", () => {
    // A minimal pack with no spare animations has nothing to play. Picking one
    // anyway would mean picking one that claims something false.
    const minimal = {
      ...pack,
      animations: pack.animations.filter((a) =>
        ["idle", "thinking", "writing_continuous"].includes(a.id),
      ),
      states: { idle: "idle", thinking: "thinking", writing: "writing_continuous" },
    };
    expect(ambientEmotePool(minimal)).toEqual([]);
  });

  it("respects a pack marking an animation unselectable", () => {
    const hidden = {
      ...pack,
      animations: pack.animations.map((a) =>
        a.id === "pleased" ? { ...a, selectable: false } : a,
      ),
    };
    expect(ambientEmotePool(hidden).map((a) => a.id)).toEqual(["expect"]);
  });
});
