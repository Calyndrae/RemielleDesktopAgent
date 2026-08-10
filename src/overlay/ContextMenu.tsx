import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./chat/icons";
import { useHitRegion } from "./hitRegions";

export interface MenuItem {
  id: string;
  label: string;
  /** Renders a check mark. Omit for plain actions. */
  checked?: boolean;
  danger?: boolean;
  /** Shown but unselectable — e.g. "export" with nothing yet to export. */
  disabled?: boolean;
  onSelect: () => void;
  /**
   * Fired when the pointer settles on the item. Exists for the emote palette,
   * where the preview *is* the character trying the pose on — no thumbnail
   * could compete with the real sprite doing the real animation.
   */
  onHover?: () => void;
  /**
   * Selecting this item leaves the menu open. Exists for "再试一次" in the
   * model list: closing on retry would make the user reopen the menu just to
   * see whether the retry worked.
   */
  keepOpen?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /**
   * Passthrough-registry key. Distinct per call site: two menus can be open at
   * once (the character's and the composer's), and a shared id would let one
   * unmounting menu delete the other's interaction area.
   */
  regionId?: string;
  /** Anchor the menu's bottom edge at `y` instead of its top. */
  above?: boolean;
}

/** Keeps the menu this far from the work-area edges. */
const EDGE_MARGIN = 8;

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  regionId = "context-menu",
  above = false,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y, ready: false });

  useHitRegion(regionId, ref);

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
      y: Math.max(EDGE_MARGIN, Math.min(above ? y - height : y, maxY)),
      ready: true,
    });
  }, [x, y, above, items.length]);

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

  /*
   * Portalled to the body.
   *
   * The menu positions itself in viewport coordinates, so it must not inherit a
   * containing block from wherever it happens to be rendered. The composer sets
   * `position: relative` for its toast, which silently re-anchored the menu
   * opened from the "+" button and pushed it off the bottom of the panel.
   */
  // The tick gutter only earns its width when something in the menu can be
  // ticked. The export menu has no toggles, and reserving the column there just
  // indented every label past an empty stripe.
  const checkable = items.some((item) => item.checked !== undefined);

  return createPortal(
    <div
      ref={ref}
      className={`menu${checkable ? " menu--checkable" : ""}`}
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
          disabled={item.disabled ?? false}
          onPointerEnter={item.onHover}
          onClick={() => {
            item.onSelect();
            if (!item.keepOpen) onClose();
          }}
        >
          {checkable && (
            <span className="menu__check" aria-hidden="true">
              {item.checked && <Icon.Check size={14} />}
            </span>
          )}
          <span className="menu__label">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
