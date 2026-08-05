/**
 * The chat panel's flight into the character when it closes.
 *
 * The brief: the panel blurs, deforms, follows a parabolic arc toward the
 * sprite with physically plausible motion, stretches along its direction of
 * travel, and vanishes behind her.
 *
 * Projectile motion is what makes it read as physical — horizontal progress at
 * a steady rate, vertical position a parabola. The one liberty taken is a mild
 * ease on the progress parameter, so the panel accelerates into the character
 * as if pulled rather than coasting to a stop.
 */

export interface FlightEndpoints {
  /** Panel centre at rest. */
  fromX: number;
  fromY: number;
  /** Sprite centre — where the panel is headed. */
  toX: number;
  toY: number;
}

export interface FlightOptions {
  /**
   * Peak rise of the arc above the straight line between the endpoints, in
   * pixels. Positive arcs upward.
   */
  arcHeight: number;
  /** Exponent applied to progress. >1 accelerates into the target. */
  easeExponent: number;
  /** Scale at the end of the flight. */
  endScale: number;
  /** Blur at the end of the flight, in pixels. */
  maxBlur: number;
  /**
   * How strongly speed stretches the panel along its direction of travel.
   * The perpendicular axis is squashed by the reciprocal, so apparent volume
   * is preserved — the squash-and-stretch rule from hand animation.
   */
  stretchStrength: number;
  /** Progress at which the panel starts fading out. */
  fadeStart: number;
}

export const DEFAULT_FLIGHT: FlightOptions = {
  arcHeight: 90,
  easeExponent: 1.6,
  endScale: 0.08,
  maxBlur: 14,
  stretchStrength: 0.0016,
  fadeStart: 0.72,
};

export interface FlightPose {
  x: number;
  y: number;
  /** Uniform scale before squash and stretch. */
  scale: number;
  /** Stretch factor along `angle`; the perpendicular axis uses its reciprocal. */
  stretch: number;
  /** Direction of travel, in radians. */
  angle: number;
  blur: number;
  opacity: number;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Position along the arc at raw progress `t`. */
function positionAt(t: number, ends: FlightEndpoints, options: FlightOptions) {
  const eased = Math.pow(clamp01(t), options.easeExponent);
  return {
    x: ends.fromX + (ends.toX - ends.fromX) * eased,
    // 4t(1-t) peaks at 1 when t is 0.5, giving a clean parabolic hop.
    y:
      ends.fromY +
      (ends.toY - ends.fromY) * eased -
      options.arcHeight * 4 * eased * (1 - eased),
  };
}

/**
 * Full pose at progress `t` in [0, 1].
 *
 * Velocity is differentiated numerically rather than derived analytically: the
 * easing is a free parameter, and a finite difference stays correct whatever
 * curve is plugged in.
 */
export function flightPose(
  t: number,
  ends: FlightEndpoints,
  options: FlightOptions = DEFAULT_FLIGHT,
): FlightPose {
  const progress = clamp01(t);
  const epsilon = 0.001;

  const here = positionAt(progress, ends, options);
  const ahead = positionAt(Math.min(1, progress + epsilon), ends, options);

  const dx = ahead.x - here.x;
  const dy = ahead.y - here.y;
  const speed = Math.hypot(dx, dy) / epsilon;

  // A stationary panel has no meaningful direction; keep the previous frame's
  // orientation implicitly by falling back to horizontal.
  const angle = speed > 0 ? Math.atan2(dy, dx) : 0;

  const stretch = 1 + speed * options.stretchStrength;

  const fadeSpan = 1 - options.fadeStart;
  const opacity =
    progress <= options.fadeStart || fadeSpan <= 0
      ? 1
      : 1 - (progress - options.fadeStart) / fadeSpan;

  return {
    x: here.x,
    y: here.y,
    scale: 1 + (options.endScale - 1) * progress,
    stretch,
    angle,
    blur: options.maxBlur * progress * progress,
    opacity: clamp01(opacity),
  };
}

/**
 * CSS transform for a pose, assuming the element is centred on its own origin.
 *
 * Rotating into the direction of travel, scaling anisotropically, then rotating
 * back keeps the stretch aligned with motion regardless of the element's own
 * orientation.
 */
export function poseToTransform(pose: FlightPose): string {
  const degrees = (pose.angle * 180) / Math.PI;
  return [
    `translate3d(${pose.x}px, ${pose.y}px, 0)`,
    `rotate(${degrees}deg)`,
    `scale(${pose.scale * pose.stretch}, ${pose.scale / pose.stretch})`,
    `rotate(${-degrees}deg)`,
  ].join(" ");
}
