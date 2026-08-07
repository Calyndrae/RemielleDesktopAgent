import { useRef } from "react";
import { useHitRegion } from "./hitRegions";

interface FaultPanelProps {
  title: string;
  body: string;
  detail: string;
  retryLabel: string;
  onRetry: () => void;
}

/**
 * Startup failure surface — most often a pack whose GIFs haven't been dropped in
 * yet.
 *
 * Registers itself as an interaction area: the overlay is click-through by
 * default, so without this the panel would render but its Retry button would be
 * dead, and the app would look frozen with no way out.
 */
export function FaultPanel({
  title,
  body,
  detail,
  retryLabel,
  onRetry,
}: FaultPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  useHitRegion("fault-panel", ref);

  return (
    <div className="fault" ref={ref}>
      <h1 className="fault__title">{title}</h1>
      <p className="fault__body">{body}</p>
      <pre className="fault__detail">{detail}</pre>
      <button type="button" className="fault__retry" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  );
}
