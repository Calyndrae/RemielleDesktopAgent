/**
 * Icon set.
 *
 * Every icon is an SVG on a fixed viewBox, never a text glyph. Glyphs like "+",
 * "✕" and "✓" sit on a font's baseline with side bearings that differ per
 * family and per fallback, so they land visibly off-centre inside a round
 * button and shift again whenever the font stack resolves differently. An SVG
 * has no baseline and no bearings: centring it is exact and identical
 * everywhere.
 *
 * All paths draw in `currentColor` and inherit size from the `size` prop, so a
 * button controls colour and scale in one place.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({
  size = 16,
  className,
  children,
  filled = false,
}: IconProps & { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Plus: (props: IconProps) => (
    <Svg {...props}>
      <path d="M10 4.5v11M4.5 10h11" />
    </Svg>
  ),

  Close: (props: IconProps) => (
    <Svg {...props}>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </Svg>
  ),

  Check: (props: IconProps) => (
    <Svg {...props}>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </Svg>
  ),

  ArrowUp: (props: IconProps) => (
    <Svg {...props}>
      <path d="M10 15.5v-11M5 9.5L10 4.5l5 5" />
    </Svg>
  ),

  Stop: (props: IconProps) => (
    <Svg {...props} filled>
      <rect x="6" y="6" width="8" height="8" rx="1.6" />
    </Svg>
  ),

  ChevronDown: (props: IconProps) => (
    <Svg {...props}>
      <path d="M6 8.5l4 4 4-4" />
    </Svg>
  ),




  Copy: (props: IconProps) => (
    <Svg {...props}>
      <rect x="7.25" y="7.25" width="9" height="9" rx="2" />
      <path d="M12.75 4.75h-8a1 1 0 00-1 1v8" />
    </Svg>
  ),




  Globe: (props: IconProps) => (
    <Svg {...props}>
      <circle cx="10" cy="10" r="6.75" />
      <path d="M3.25 10h13.5M10 3.25c1.7 1.9 2.55 4.15 2.55 6.75S11.7 14.85 10 16.75c-1.7-1.9-2.55-4.15-2.55-6.75S8.3 5.15 10 3.25z" />
    </Svg>
  ),

  /*
   * Search off.
   *
   * A separate glyph rather than the same globe in a different fill. Once the
   * toggle lost its text label it became a 30px circle whose entire state
   * signal was "filled disc" against "outline ring" — at that size, on and off
   * were not tellable apart at a glance, which is the one thing this control
   * has to answer. A slash is legible at any size and in greyscale.
   */
  GlobeOff: (props: IconProps) => (
    <Svg {...props}>
      <circle cx="10" cy="10" r="6.75" />
      <path d="M3.25 10h13.5M10 3.25c1.7 1.9 2.55 4.15 2.55 6.75S11.7 14.85 10 16.75c-1.7-1.9-2.55-4.15-2.55-6.75S8.3 5.15 10 3.25z" />
      <path d="M4.4 4.4l11.2 11.2" />
    </Svg>
  ),

  Gear: (props: IconProps) => (
    <Svg {...props}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M15.6 12.2a1.3 1.3 0 00.26 1.43l.05.05a1.55 1.55 0 11-2.2 2.2l-.04-.05a1.3 1.3 0 00-1.44-.26 1.3 1.3 0 00-.79 1.19v.13a1.55 1.55 0 11-3.1 0v-.07a1.3 1.3 0 00-.85-1.19 1.3 1.3 0 00-1.43.26l-.05.05a1.55 1.55 0 11-2.2-2.2l.05-.05a1.3 1.3 0 00.26-1.43 1.3 1.3 0 00-1.19-.79h-.13a1.55 1.55 0 010-3.1h.07a1.3 1.3 0 001.19-.85 1.3 1.3 0 00-.26-1.43l-.05-.05a1.55 1.55 0 112.2-2.2l.05.05a1.3 1.3 0 001.43.26h.06a1.3 1.3 0 00.79-1.19v-.13a1.55 1.55 0 013.1 0v.07a1.3 1.3 0 00.79 1.19 1.3 1.3 0 001.43-.26l.05-.05a1.55 1.55 0 112.2 2.2l-.05.05a1.3 1.3 0 00-.26 1.43v.06a1.3 1.3 0 001.19.79h.13a1.55 1.55 0 010 3.1h-.07a1.3 1.3 0 00-1.19.79z" />
    </Svg>
  ),

  Regenerate: (props: IconProps) => (
    <Svg {...props}>
      <path d="M16.25 10a6.25 6.25 0 11-1.9-4.5" />
      <path d="M16.5 3v3.25h-3.25" />
    </Svg>
  ),

  /**
   * The agent mark that trails the newest reply.
   *
   * A twelve-point burst, echoing the app icon: Remielle's title is "Void
   * Hunter: Temporal Lumiflux", so the motif throughout is light.
   */
  Mark: ({ size = 20, className }: IconProps) => (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        {Array.from({ length: 12 }, (_, index) => {
          const angle = (index * Math.PI) / 6;
          // Alternating lengths keep the burst from reading as a plain asterisk.
          const inner = 2.2;
          const outer = index % 2 === 0 ? 8.4 : 6.4;
          return (
            <line
              key={index}
              x1={10 + Math.cos(angle) * inner}
              y1={10 + Math.sin(angle) * inner}
              x2={10 + Math.cos(angle) * outer}
              y2={10 + Math.sin(angle) * outer}
            />
          );
        })}
      </g>
    </svg>
  ),
};
