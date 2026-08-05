/**
 * Critically-ish damped spring integrator.
 *
 * Used for the sprite's drag: the character should *trail* the cursor and
 * settle with a little overshoot rather than being welded to it. Hand-rolled
 * rather than delegated to an animation library because the caller needs the
 * resolved position every frame — it feeds the hit rectangles published to the
 * Rust passthrough poller.
 */

export interface SpringConfig {
  /** Higher = snappier pull toward the target. */
  stiffness: number;
  /** Higher = less oscillation. Below ~2*sqrt(stiffness) the spring overshoots. */
  damping: number;
  mass: number;
  /** Distance and velocity below which the spring is considered settled. */
  restDelta: number;
}

export const DEFAULT_SPRING: SpringConfig = {
  stiffness: 170,
  damping: 26,
  mass: 1,
  restDelta: 0.01,
};

/**
 * Fixed integration step in seconds.
 *
 * The spring is integrated in fixed substeps rather than one variable-length
 * step: a long frame (a GC pause, a dropped frame) fed straight into an
 * explicit Euler integrator makes it gain energy and visibly fling the sprite.
 */
const FIXED_STEP = 1 / 120;

/** Longest real time consumed by a single `step` call, in seconds. */
const MAX_FRAME_TIME = 0.064;

export interface SpringState {
  value: number;
  velocity: number;
}

export function createSpring(value: number): SpringState {
  return { value, velocity: 0 };
}

/**
 * Advances `state` toward `target` by `dt` seconds. Mutates and returns it.
 */
export function step(
  state: SpringState,
  target: number,
  dt: number,
  config: SpringConfig = DEFAULT_SPRING,
): SpringState {
  // Clamping keeps a stalled tab (or a breakpoint) from exploding the spring.
  let remaining = Math.min(dt, MAX_FRAME_TIME);

  while (remaining > 0) {
    const h = Math.min(FIXED_STEP, remaining);
    remaining -= h;

    const displacement = state.value - target;
    const springForce = -config.stiffness * displacement;
    const dampingForce = -config.damping * state.velocity;
    const acceleration = (springForce + dampingForce) / config.mass;

    state.velocity += acceleration * h;
    state.value += state.velocity * h;
  }

  if (isSettled(state, target, config)) {
    state.value = target;
    state.velocity = 0;
  }

  return state;
}

export function isSettled(
  state: SpringState,
  target: number,
  config: SpringConfig = DEFAULT_SPRING,
): boolean {
  return (
    Math.abs(state.value - target) < config.restDelta &&
    Math.abs(state.velocity) < config.restDelta
  );
}

/** A 2D spring, since positions always move in pairs. */
export interface Spring2D {
  x: SpringState;
  y: SpringState;
}

export function createSpring2D(x: number, y: number): Spring2D {
  return { x: createSpring(x), y: createSpring(y) };
}

export function step2D(
  spring: Spring2D,
  targetX: number,
  targetY: number,
  dt: number,
  config: SpringConfig = DEFAULT_SPRING,
): Spring2D {
  step(spring.x, targetX, dt, config);
  step(spring.y, targetY, dt, config);
  return spring;
}

export function isSettled2D(
  spring: Spring2D,
  targetX: number,
  targetY: number,
  config: SpringConfig = DEFAULT_SPRING,
): boolean {
  return (
    isSettled(spring.x, targetX, config) && isSettled(spring.y, targetY, config)
  );
}
