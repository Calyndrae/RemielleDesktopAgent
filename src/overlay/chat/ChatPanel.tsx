import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { DEFAULT_FLIGHT, flightPose, poseToTransform } from "@/anim/parabola";
import type { OverlayGeometry } from "@/lib/ipc";
import { openSettings } from "@/lib/settingsWindow";
import { useChatStore } from "@/state/chat";
import { getSpriteFrame } from "../spritePosition";
import { useHitRegion } from "../hitRegions";
import { Composer } from "./Composer";
import { ConfirmPrompt } from "./ConfirmPrompt";
import { EmptyState } from "./EmptyState";
import { Icon } from "./icons";
import { Message } from "./Message";

/** Close flight duration. */
const CLOSE_MS = 450;
/** Entrance duration; snappier than the exit, which is the showy one. */
const OPEN_MS = 260;

const EDGE_MARGIN = 20;
/** Gap between the character and the panel. */
const SPRITE_GAP = 18;

const clamp = (value: number, min: number, max: number) =>
  // A work area smaller than the panel would invert the bounds; keeping `min`
  // last means the panel stays on-screen at the top-left rather than jumping off.
  Math.max(Math.min(value, max), min);

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

interface PanelRect {
  width: number;
  height: number;
  centreX: number;
  centreY: number;
}

/**
 * Places the panel beside the character, on whichever side has more room, and
 * pulls it fully inside the work area.
 */
function computeRect(geometry: OverlayGeometry): PanelRect {
  const sprite = getSpriteFrame();

  const width = Math.round(clamp(geometry.width * 0.3, 320, 420));
  const height = Math.round(
    Math.min(560, Math.max(280, geometry.height - EDGE_MARGIN * 2)),
  );

  const spriteLeft = sprite.centreX - sprite.width / 2;
  const spriteRight = sprite.centreX + sprite.width / 2;
  const roomLeft = spriteLeft;
  const roomRight = geometry.width - spriteRight;

  const preferRight = roomRight >= roomLeft;
  const centreX = preferRight
    ? spriteRight + SPRITE_GAP + width / 2
    : spriteLeft - SPRITE_GAP - width / 2;

  return {
    width,
    height,
    centreX: clamp(
      centreX,
      EDGE_MARGIN + width / 2,
      geometry.width - EDGE_MARGIN - width / 2,
    ),
    centreY: clamp(
      sprite.centreY,
      EDGE_MARGIN + height / 2,
      geometry.height - EDGE_MARGIN - height / 2,
    ),
  };
}

interface ChatPanelProps {
  geometry: OverlayGeometry;
}

export function ChatPanel({ geometry }: ChatPanelProps) {
  const phase = useChatStore((s) => s.phase);
  const messages = useChatStore((s) => s.messages);
  const sessionUsage = useChatStore((s) => s.sessionUsage);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = phase !== "closed";
  // During the close flight the panel is a flying object, not a surface: it
  // must stop capturing the cursor the instant the animation starts.
  useHitRegion("chat-panel", rootRef, phase === "open" || phase === "opening");

  // Frozen for the lifetime of the panel. Recomputing while it is open would
  // make it jump whenever the character is dragged.
  const rect = useMemo(
    () => computeRect(geometry),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, geometry.width, geometry.height],
  );

  // Resting transform, also the starting point of the close flight.
  //
  // On open the panel springs out from the character's direction rather than
  // appearing in place, so the two animations bookend each other: it comes from
  // her and it goes back to her.
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element || phase === "closing") return;

    const resting = `translate3d(${rect.centreX}px, ${rect.centreY}px, 0)`;

    if (phase !== "opening" || prefersReducedMotion()) {
      element.style.transition = "none";
      element.style.transform = resting;
      return;
    }

    const sprite = getSpriteFrame();
    const startX = rect.centreX + (sprite.centreX - rect.centreX) * 0.35;
    const startY = rect.centreY + (sprite.centreY - rect.centreY) * 0.35;

    element.style.transition = "none";
    element.style.transform = `translate3d(${startX}px, ${startY}px, 0) scale(0.82)`;
    // Force a style flush so the browser treats the two transforms as separate
    // states; without it they collapse and nothing animates.
    void element.offsetWidth;
    element.style.transition = `transform ${OPEN_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    element.style.transform = resting;
  }, [rect, phase]);

  // Entrance.
  useEffect(() => {
    if (phase !== "opening") return;
    const done = window.setTimeout(
      () => useChatStore.getState().finishOpen(),
      prefersReducedMotion() ? 0 : OPEN_MS,
    );
    return () => window.clearTimeout(done);
  }, [phase]);

  // Exit: blur, deform, and fly into the character along an arc.
  useEffect(() => {
    if (phase !== "closing") return;
    const element = rootRef.current;
    if (!element) {
      useChatStore.getState().finishClose();
      return;
    }

    if (prefersReducedMotion()) {
      element.style.transition = "opacity 120ms linear";
      element.style.opacity = "0";
      const done = window.setTimeout(() => useChatStore.getState().finishClose(), 120);
      return () => window.clearTimeout(done);
    }

    // The flight writes `transform` every frame; a leftover transition from the
    // entrance would fight it and smear the motion.
    element.style.transition = "none";

    const sprite = getSpriteFrame();
    const ends = {
      fromX: rect.centreX,
      fromY: rect.centreY,
      toX: sprite.centreX,
      toY: sprite.centreY,
    };

    // Arc away from the character before curving in, so the flight reads as
    // thrown rather than dragged along a straight line.
    const options = {
      ...DEFAULT_FLIGHT,
      arcHeight: Math.max(60, Math.abs(ends.toX - ends.fromX) * 0.22),
    };

    let frame = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / CLOSE_MS);
      const pose = flightPose(t, ends, options);

      element.style.transform = poseToTransform(pose);
      element.style.filter = `blur(${pose.blur.toFixed(2)}px)`;
      element.style.opacity = pose.opacity.toFixed(3);

      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        useChatStore.getState().finishClose();
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, rect]);

  const lastAssistantIndex = messages.reduce(
    (latest, message, index) => (message.role === "assistant" ? index : latest),
    -1,
  );

  // Keep the newest content in view as it streams in, and mark the container as
  // scrollable so the edge fade only applies when something is actually cut off.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;

    const sync = () =>
      element.classList.toggle(
        "panel__scroll--scrollable",
        element.scrollHeight > element.clientHeight + 1,
      );
    sync();

    // Expanding a reasoning or sources row changes the content height without
    // touching `messages`, so height has to be observed rather than derived.
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [messages]);

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      className={`panel panel--${phase}`}
      style={{
        width: rect.width,
        height: rect.height,
        // Negative margins centre the element on its own translate point, so
        // the flight math can work in centre coordinates and scaling stays
        // anchored to the middle.
        marginLeft: -rect.width / 2,
        marginTop: -rect.height / 2,
        animationDuration: phase === "opening" ? `${OPEN_MS}ms` : undefined,
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <header className="panel__header">
        <span className="panel__title">蕾米埃尔</span>
        {/* Running cost, always visible rather than buried in a menu. */}
        {sessionUsage.total > 0 && (
          <span
            className="panel__tokens"
            title={`本次会话：输入 ${sessionUsage.prompt} · 输出 ${sessionUsage.completion}`}
          >
            {sessionUsage.total.toLocaleString()} tok
          </span>
        )}
        <button
          type="button"
          className="iconbtn iconbtn--ghost"
          onClick={() => void openSettings()}
          title="设置"
          aria-label="设置"
        >
          <Icon.Gear size={15} />
        </button>
        <button
          type="button"
          className="iconbtn iconbtn--ghost"
          onClick={() => useChatStore.getState().requestClose()}
          title="关闭"
          aria-label="关闭"
        >
          <Icon.Close size={15} />
        </button>
      </header>

      <div className="panel__scroll" ref={scrollRef}>
        {messages.length === 0 && <EmptyState />}
        {messages.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            // Exactly one mark in the transcript, on the newest reply.
            isLatestAssistant={
              message.role === "assistant" && index === lastAssistantIndex
            }
          />
        ))}
      </div>

      <ConfirmPrompt />
      <Composer />
    </div>
  );
}
