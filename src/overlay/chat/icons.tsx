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

  ChevronRight: (props: IconProps) => (
    <Svg {...props}>
      <path d="M8 5.5l4.5 4.5L8 14.5" />
    </Svg>
  ),

  Mic: (props: IconProps) => (
    <Svg {...props}>
      <rect x="7.75" y="2.75" width="4.5" height="9" rx="2.25" />
      <path d="M4.75 9.5a5.25 5.25 0 0010.5 0M10 14.75v2.5" />
    </Svg>
  ),

  Waveform: (props: IconProps) => (
    <Svg {...props}>
      <path d="M4 8.5v3M7 5.5v9M10 3.5v13M13 6.5v7M16 8.5v3" />
    </Svg>
  ),

  Copy: (props: IconProps) => (
    <Svg {...props}>
      <rect x="7.25" y="7.25" width="9" height="9" rx="2" />
      <path d="M12.75 4.75h-8a1 1 0 00-1 1v8" />
    </Svg>
  ),

  Speaker: (props: IconProps) => (
    <Svg {...props}>
      <path d="M4 8v4h2.5L10 15V5L6.5 8H4z" />
      <path d="M13 7.75a3.25 3.25 0 010 4.5" />
    </Svg>
  ),

  ThumbUp: (props: IconProps) => (
    <Svg {...props}>
      <path d="M6.5 17V9l3.75-5c1.1 0 1.9.9 1.75 2l-.5 3H16a1.5 1.5 0 011.45 1.9l-1.4 5A1.5 1.5 0 0114.6 17H6.5z" />
      <path d="M6.5 9H3.75v8H6.5" />
    </Svg>
  ),

  ThumbDown: (props: IconProps) => (
    <Svg {...props}>
      <path d="M6.5 3v8l3.75 5c1.1 0 1.9-.9 1.75-2l-.5-3H16a1.5 1.5 0 001.45-1.9l-1.4-5A1.5 1.5 0 0014.6 3H6.5z" />
      <path d="M6.5 11H3.75V3H6.5" />
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
