import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./chat/icons";
import { useHitRegion } from "./hitRegions";

export interface MenuItem {
  id: string;
  label: string;
  /** Renders a check mark. Omit for plain actions. */
  checked?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** Keeps the menu this far from the work-area edges. */
const EDGE_MARGIN = 8;

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y, ready: false });

  useHitRegion("context-menu", ref);

  // Flip the menu back on-screen once its real size is known. Rendering
  // invisibly for one frame avoids a visible jump from the naive position.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const { offsetWidth: width, offsetHeight: height } = element;
    const maxX = window.innerWidth - width - EDGE_MARGIN;
    const maxY = window.innerHeight - height - EDGE_MARGIN;

    setPosition({
      x: Math.max(EDGE_MARGIN, Math.min(x, maxX)),
      y: Math.max(EDGE_MARGIN, Math.min(y, maxY)),
      ready: true,
    });
  }, [x, y, items.length]);

  // Any click outside, or Escape, dismisses. Capture phase so the sprite's own
  // handlers don't win first.
  useLayoutEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        visibility: position.ready ? "visible" : "hidden",
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`menu__item${item.danger ? " menu__item--danger" : ""}`}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          <span className="menu__check" aria-hidden="true">
            {item.checked && <Icon.Check size={14} />}
          </span>
          <span className="menu__label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
