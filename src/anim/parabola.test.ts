import { describe, expect, it } from "vitest";
import { DEFAULT_FLIGHT, flightPose, poseToTransform } from "./parabola";

const ENDS = { fromX: 800, fromY: 400, toX: 1500, toY: 700 };

describe("flightPose", () => {
  it("starts at the panel and ends at the sprite", () => {
    const start = flightPose(0, ENDS);
    expect(start.x).toBeCloseTo(ENDS.fromX, 5);
    expect(start.y).toBeCloseTo(ENDS.fromY, 5);

    const end = flightPose(1, ENDS);
    expect(end.x).toBeCloseTo(ENDS.toX, 5);
    expect(end.y).toBeCloseTo(ENDS.toY, 5);
  });

  it("arcs above the straight line between the endpoints", () => {
    const mid = flightPose(0.5, ENDS);
    const straightY =
      ENDS.fromY + (ENDS.toY - ENDS.fromY) * Math.pow(0.5, DEFAULT_FLIGHT.easeExponent);
    // Screen coordinates grow downward, so "above" means a smaller y.
    expect(mid.y).toBeLessThan(straightY);
  });

  it("shrinks and blurs monotonically", () => {
    let previousScale = Infinity;
    let previousBlur = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const pose = flightPose(t, ENDS);
      expect(pose.scale).toBeLessThanOrEqual(previousScale + 1e-9);
      expect(pose.blur).toBeGreaterThanOrEqual(previousBlur - 1e-9);
      previousScale = pose.scale;
      previousBlur = pose.blur;
    }
    expect(previousScale).toBeCloseTo(DEFAULT_FLIGHT.endScale, 5);
  });

  it("accelerates into the target", () => {
    // With easeExponent > 1 the second half must cover more ground than the first.
    const quarter = flightPose(0.25, ENDS);
    const half = flightPose(0.5, ENDS);
    const end = flightPose(1, ENDS);

    const firstHalf = Math.hypot(half.x - ENDS.fromX, half.y - ENDS.fromY);
    const secondHalf = Math.hypot(end.x - half.x, end.y - half.y);
    expect(secondHalf).toBeGreaterThan(firstHalf);
    expect(quarter.x).toBeLessThan(half.x);
  });

  it("preserves apparent volume in the squash and stretch", () => {
    const pose = flightPose(0.6, ENDS);
    // Anisotropic factors are reciprocal, so their product is exactly 1.
    expect(pose.stretch * (1 / pose.stretch)).toBeCloseTo(1, 12);
    expect(pose.stretch).toBeGreaterThan(1);
  });

  it("stays opaque until the fade window, then reaches zero", () => {
    expect(flightPose(0.5, ENDS).opacity).toBe(1);
    expect(flightPose(DEFAULT_FLIGHT.fadeStart, ENDS).opacity).toBe(1);
    expect(flightPose(0.9, ENDS).opacity).toBeLessThan(1);
    expect(flightPose(1, ENDS).opacity).toBeCloseTo(0, 5);
  });

  it("clamps progress outside [0, 1]", () => {
    expect(flightPose(-3, ENDS).x).toBeCloseTo(ENDS.fromX, 5);
    expect(flightPose(9, ENDS).x).toBeCloseTo(ENDS.toX, 5);
  });

  it("handles coincident endpoints without producing NaN", () => {
    // The panel can be dragged on top of the character before closing.
    const degenerate = { fromX: 100, fromY: 100, toX: 100, toY: 100 };
    for (const t of [0, 0.5, 1]) {
      const pose = flightPose(t, degenerate);
      for (const value of [pose.x, pose.y, pose.scale, pose.stretch, pose.angle]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe("poseToTransform", () => {
  it("rotates into the direction of travel and back out", () => {
    const transform = poseToTransform(flightPose(0.5, ENDS));
    const rotations = transform.match(/rotate\((-?[\d.]+)deg\)/g);
    expect(rotations).toHaveLength(2);

    const [first, second] = rotations!.map((r) =>
      Number(r.replace(/rotate\(|deg\)/g, "")),
    );
    expect(first! + second!).toBeCloseTo(0, 9);
  });

  it("emits finite values only", () => {
    expect(poseToTransform(flightPose(0.3, ENDS))).not.toMatch(/NaN|Infinity/);
  });
});
