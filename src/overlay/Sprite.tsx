import { useEffect, useLayoutEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { createSpring2D, isSettled2D, step2D } from "@/anim/spring";
import { buildAlphaMask, MASK_COLS, MASK_ROWS, solidMask } from "@/lib/alphaMask";
import { ipc, type OverlayGeometry, type Rect } from "@/lib/ipc";
import { resolveAnimation, useAgentStore } from "@/state/agent";
import { useSpriteStore } from "@/state/sprite";
import type { PackManifest } from "@/types/pack";

/** Fraction of the sprite that must stay within the work area. */
const MIN_VISIBLE = 0.3;

/** Pointer travel below this (in px) still counts as a click, not a drag. */
const CLICK_SLOP = 4;

/** How often the alpha mask is re-derived from the animation's current frame. */
const MASK_REBUILD_MS = 120;

/** Republish the mask when the sprite has moved at least this far. */
const REPUBLISH_DISTANCE = 2;

/** Scale change per wheel notch. */
const WHEEL_SCALE_STEP = 0.08;

interface SpriteProps {
  pack: PackManifest;
  geometry: OverlayGeometry;
  /** Left click on an opaque pixel. */
  onActivate: () => void;
  onContextMenu: (x: number, y: number) => void;
}

export function Sprite({ pack, geometry, onActivate, onContextMenu }: SpriteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const agentState = useAgentStore((s) => s.state);
  const emoteOverride = useAgentStore((s) => s.emoteOverride);
  const scale = useSpriteStore((s) => s.scale);
  const anchorX = useSpriteStore((s) => s.anchorX);
  const anchorY = useSpriteStore((s) => s.anchorY);
  const pinned = useSpriteStore((s) => s.pinned);

  const animation = resolveAnimation(pack, agentState, emoteOverride);

  const width = pack.frameSize.width * scale;
  const height = pack.frameSize.height * scale;

  /**
   * Everything the animation loop reads, kept in a ref so the loop never
   * restarts on re-render and never closes over a stale value.
   */
  const live = useRef({
    width,
    height,
    geometry,
    pinned,
    offsetX: animation?.offset.x ?? 0,
    offsetY: animation?.offset.y ?? 0,
  });
  live.current = {
    width,
    height,
    geometry,
    pinned,
    offsetX: animation?.offset.x ?? 0,
    offsetY: animation?.offset.y ?? 0,
  };

  /** Sprite centre, in overlay logical pixels. */
  const spring = useRef(
    createSpring2D(anchorX * geometry.width, anchorY * geometry.height),
  );
  const target = useRef({
    x: anchorX * geometry.width,
    y: anchorY * geometry.height,
  });

  const drag = useRef({
    active: false,
    pointerId: -1,
    grabX: 0,
    grabY: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });

  const publish = useRef({
    bits: null as number[] | null,
    lastBuiltAt: 0,
    lastRect: null as Rect | null,
  });

  /** Keeps the centre far enough inside the work area to stay grabbable. */
  const clampCentre = (x: number, y: number) => {
    const { width: w, height: h, geometry: geo } = live.current;
    const halfW = w / 2;
    const halfH = h / 2;
    return {
      x: Math.min(
        Math.max(x, MIN_VISIBLE * w - halfW),
        geo.width - MIN_VISIBLE * w + halfW,
      ),
      y: Math.min(
        Math.max(y, MIN_VISIBLE * h - halfH),
        geo.height - MIN_VISIBLE * h + halfH,
      ),
    };
  };

  // Follow the persisted anchor whenever it or the work area changes, except
  // mid-drag where the pointer owns the target.
  useLayoutEffect(() => {
    if (drag.current.active) return;
    const next = clampCentre(anchorX * geometry.width, anchorY * geometry.height);
    target.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorX, anchorY, geometry.width, geometry.height, scale]);

  // The animation loop: integrate the spring, write the transform, and keep
  // the Rust hit-test data current.
  useEffect(() => {
    let frame = 0;
    let previous = performance.now();

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      const dt = (now - previous) / 1000;
      previous = now;

      const settled = isSettled2D(spring.current, target.current.x, target.current.y);
      if (!settled) {
        step2D(spring.current, target.current.x, target.current.y, dt);
      }

      const { width: w, height: h } = live.current;
      const left = spring.current.x.value - w / 2;
      const top = spring.current.y.value - h / 2;

      const element = containerRef.current;
      if (element) {
        element.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      }

      publishMask(left, top, w, h, now);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function publishMask(left: number, top: number, w: number, h: number, now: number) {
    const rect: Rect = { x: left, y: top, width: w, height: h };
    const state = publish.current;

    const needsRebuild = now - state.lastBuiltAt >= MASK_REBUILD_MS;
    if (needsRebuild) {
      const image = imageRef.current;
      if (image?.complete && image.naturalWidth > 0) {
        // A tainted canvas or an undecodable frame yields null; falling back to
        // a solid mask keeps the character clickable, just with square edges.
        state.bits =
          buildAlphaMask(image, image.naturalWidth, image.naturalHeight) ?? solidMask();
      }
      state.lastBuiltAt = now;
    }

    if (!state.bits) return;

    const previous = state.lastRect;
    const moved =
      !previous ||
      Math.abs(previous.x - rect.x) >= REPUBLISH_DISTANCE ||
      Math.abs(previous.y - rect.y) >= REPUBLISH_DISTANCE ||
      previous.width !== rect.width ||
      previous.height !== rect.height;

    if (!moved && !needsRebuild) return;

    state.lastRect = rect;
    void ipc.setSpriteMask({
      rect,
      cols: MASK_COLS,
      rows: MASK_ROWS,
      bits: state.bits,
    });
  }

  // Clear the mask on unmount so a stale rectangle can't keep swallowing clicks.
  useEffect(() => () => void ipc.setSpriteMask(null), []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    drag.current = {
      active: true,
      pointerId: event.pointerId,
      grabX: event.clientX - spring.current.x.value,
      grabY: event.clientY - spring.current.y.value,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    // The cursor routinely outruns the spring-lagged sprite; without this the
    // pointer would leave the hit mask and the overlay would go click-through
    // mid-drag.
    void ipc.setForceInteractive(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state.active || event.pointerId !== state.pointerId) return;

    if (
      Math.abs(event.clientX - state.startX) > CLICK_SLOP ||
      Math.abs(event.clientY - state.startY) > CLICK_SLOP
    ) {
      state.moved = true;
    }

    if (live.current.pinned) return;

    target.current = clampCentre(
      event.clientX - state.grabX,
      event.clientY - state.grabY,
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state.active || event.pointerId !== state.pointerId) return;

    state.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void ipc.setForceInteractive(false);

    if (!state.moved) {
      onActivate();
      return;
    }

    if (!live.current.pinned) {
      const { geometry: geo } = live.current;
      useSpriteStore
        .getState()
        .setAnchor(target.current.x / geo.width, target.current.y / geo.height);
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const direction = event.deltaY > 0 ? -1 : 1;
    useSpriteStore.getState().nudgeScale(direction * WHEEL_SCALE_STEP);
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onContextMenu(event.clientX, event.clientY);
  };

  if (!animation) return null;

  return (
    <div
      ref={containerRef}
      className="sprite"
      style={{ width, height }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={handleWheel}
      onContextMenu={handleContextMenu}
    >
      <img
        ref={imageRef}
        className="sprite__image"
        // Keying by animation id restarts the GIF on a state change, which is
        // what we want: thinking should begin at its first frame.
        key={animation.id}
        src={convertFileSrc(animation.path)}
        alt=""
        draggable={false}
        style={{
          transform: `translate(${animation.offset.x * scale}px, ${
            animation.offset.y * scale
          }px)`,
        }}
      />
    </div>
  );
}
