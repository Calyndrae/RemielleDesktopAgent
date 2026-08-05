import { describe, expect, it } from "vitest";
import {
  createSpring,
  DEFAULT_SPRING,
  isSettled,
  step,
  type SpringConfig,
} from "./spring";

/** Runs the spring for `seconds` at a steady frame rate. */
function simulate(
  from: number,
  target: number,
  seconds: number,
  dt = 1 / 60,
  config: SpringConfig = DEFAULT_SPRING,
) {
  const state = createSpring(from);
  for (let t = 0; t < seconds; t += dt) {
    step(state, target, dt, config);
  }
  return state;
}

describe("spring", () => {
  it("converges on the target", () => {
    const state = simulate(0, 100, 2);
    expect(state.value).toBeCloseTo(100, 5);
    expect(state.velocity).toBeCloseTo(0, 5);
  });

  it("lags behind rather than snapping", () => {
    // The whole point of the drag feel: one frame in, the sprite has barely
    // started moving toward a distant target.
    const state = createSpring(0);
    step(state, 1000, 1 / 60);
    expect(state.value).toBeGreaterThan(0);
    expect(state.value).toBeLessThan(100);
  });

  it("snaps exactly to the target once settled", () => {
    const state = simulate(0, 42, 3);
    // Not just "close" — settling assigns the target so the sprite can't hover
    // a fraction of a pixel off and keep republishing its hit mask forever.
    expect(state.value).toBe(42);
    expect(state.velocity).toBe(0);
    expect(isSettled(state, 42)).toBe(true);
  });

  it("stays stable across a long stalled frame", () => {
    // A 2-second frame fed straight into explicit Euler would send the value to
    // infinity; the integrator clamps and substeps instead.
    const state = createSpring(0);
    step(state, 100, 2);
    expect(Number.isFinite(state.value)).toBe(true);
    expect(Math.abs(state.value)).toBeLessThanOrEqual(100);
  });

  it("produces the same result regardless of frame rate", () => {
    const at60 = simulate(0, 100, 1, 1 / 60);
    const at144 = simulate(0, 100, 1, 1 / 144);
    // Fixed substeps mean a 144 Hz machine and a 60 Hz machine agree.
    expect(at60.value).toBeCloseTo(at144.value, 1);
  });

  it("overshoots when underdamped and does not when overdamped", () => {
    const bouncy: SpringConfig = { ...DEFAULT_SPRING, damping: 4 };
    const stiff: SpringConfig = { ...DEFAULT_SPRING, damping: 60 };

    const trackPeak = (config: SpringConfig) => {
      const state = createSpring(0);
      let peak = 0;
      for (let t = 0; t < 2; t += 1 / 120) {
        step(state, 100, 1 / 120, config);
        peak = Math.max(peak, state.value);
      }
      return peak;
    };

    expect(trackPeak(bouncy)).toBeGreaterThan(100);
    expect(trackPeak(stiff)).toBeLessThanOrEqual(100.001);
  });
});
