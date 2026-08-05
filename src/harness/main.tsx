import "./tauriStub";

import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { DEFAULT_FLIGHT, flightPose, poseToTransform } from "@/anim/parabola";
import { ChatPanel } from "@/overlay/chat/ChatPanel";
import { ContextMenu } from "@/overlay/ContextMenu";
import { FaultPanel } from "@/overlay/FaultPanel";
import { setSpriteFrame } from "@/overlay/spritePosition";
import { useChatStore, type ChatMessage } from "@/state/chat";
import "@/assets/fonts/noto-serif-sc.css";
import "@/styles/overlay.css";
import "@/styles/chat.css";

/**
 * Layout and preview harness.
 *
 * Mounts overlay surfaces in an ordinary browser page so they can be
 * screenshotted and asserted against without a Windows machine or a running
 * Tauri host. Scene is chosen with `?scene=`; see `scripts/ui-preview.mjs` and
 * `scripts/layout-check.mjs`. Excluded from the shipped bundle by the
 * `BUILD_HARNESS` guard in vite.config.ts.
 */

const STRESS = `超长单词：Pneumonoultramicroscopicsilicovolcanoconiosisandthensome_plus_a_ridiculously_long_identifier

长链接：https://example.com/a/very/long/path/that/keeps/going?query=1&another=2&yet_another=3#fragment

\`\`\`ts
const somethingWithAnAbsurdlyLongName = await client.chat.completions.create({ model: "deepseek-reasoner", stream: true });
\`\`\`

🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟

中英混排 mixed CJK and Latin should wrap normally.`;

function message(
  id: string,
  role: ChatMessage["role"],
  text: string,
  status: ChatMessage["status"] = "done",
  reasoning = "",
): ChatMessage {
  return {
    id,
    role,
    chunks: [text],
    reasoning,
    tools: [],
    usage: null,
    error: null,
    status,
    createdAt: Date.now(),
  };
}

const CONVERSATION: ChatMessage[] = [
  message("u1", "user", "嗨"),
  message(
    "a1",
    "assistant",
    "嗯？这么快就来找我了。\n\n我还以为你会多犹豫一会儿呢~ 说吧，想聊点什么？",
  ),
  message("u2", "user", "帮我看看这段代码为什么会崩"),
  message(
    "a2",
    "assistant",
    "让我猜猜——你在窗口还没显示的时候就去改它的属性了？\n\n```rust\nwindow.set_ignore_cursor_events(true)?;\n```\n\n在 GTK 下，没 realize 过的窗口是没有底层句柄的，而这个调用直接 unwrap 了。把它挪到 show() 之后就好。",
    "done",
    "他贴的是一个窗口相关的崩溃。先看调用时机——如果是在 setup 阶段调的，那窗口很可能还没 realize。GTK 下这种情况底层句柄是空的，而 tao 直接 unwrap 了。回答要直接给结论，别绕。",
  ),
];

const STREAMING: ChatMessage[] = [
  message("u1", "user", "给我讲讲你自己"),
  message(
    "a1",
    "assistant",
    "保持神秘感，是为了给下一场重逢预留余地——",
    "streaming",
    "他想听的大概不是履历。那就别背设定，挑一句能勾住人的说。",
  ),
];

const STRESS_MESSAGES: ChatMessage[] = [
  message(
    "u1",
    "user",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ),
  message("a1", "assistant", STRESS),
  message("u2", "user", "🌟"),
  message("a2", "assistant", "好呀~", "streaming"),
];

const params = new URLSearchParams(window.location.search);
const scene = params.get("scene") ?? "conversation";
const flightT = Number(params.get("t") ?? "0");
const scrollTo = params.get("scroll") ?? "bottom";

const GEOMETRY = {
  width: window.innerWidth,
  height: window.innerHeight,
  scaleFactor: 1,
  monitor: "harness",
};

// Character bottom-right, so the panel resolves to its left.
const SPRITE = { centreX: 1500, centreY: 620, width: 300, height: 300 };
setSpriteFrame(SPRITE);

/** Applies a frozen frame of the close flight, for capturing stills. */
function FlightStill({ t }: { t: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = document.querySelector<HTMLElement>(".panel");
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const pose = flightPose(
      t,
      {
        fromX: rect.left + rect.width / 2,
        fromY: rect.top + rect.height / 2,
        toX: SPRITE.centreX,
        toY: SPRITE.centreY,
      },
      {
        ...DEFAULT_FLIGHT,
        arcHeight: Math.max(60, Math.abs(SPRITE.centreX - (rect.left + rect.width / 2)) * 0.22),
      },
    );
    panel.style.transition = "none";
    panel.style.transform = poseToTransform(pose);
    panel.style.filter = `blur(${pose.blur.toFixed(2)}px)`;
    panel.style.opacity = pose.opacity.toFixed(3);
  }, [t]);

  return <div ref={ref} />;
}

/** Stand-in for the character, so scenes show what the flight aims at. */
function SpriteStandIn() {
  return (
    <div
      style={{
        position: "absolute",
        left: SPRITE.centreX - SPRITE.width / 2,
        top: SPRITE.centreY - SPRITE.height / 2,
        width: SPRITE.width,
        height: SPRITE.height,
        zIndex: 10,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 28,
          width: 124,
          height: 132,
          marginLeft: -62,
          borderRadius: "50%",
          background: "linear-gradient(160deg, #f7c5dc, #d79ad0)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 140,
          width: 168,
          height: 172,
          marginLeft: -84,
          borderRadius: "50% 50% 46% 46%",
          background: "linear-gradient(160deg, #e9a9c9, #9d6fb5)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "end center",
          paddingBottom: 6,
          color: "rgba(255,255,255,.75)",
          font: "11px system-ui",
        }}
      >
        placeholder art
      </div>
    </div>
  );
}

function Harness() {
  const [menuOpen, setMenuOpen] = useState(true);

  if (scene === "fault") {
    return (
      <FaultPanel
        title="找不到角色素材"
        body="请把 Little-Remielle 的 GIF 放进素材包目录，详见 assets/packs/little-remielle/README.md。"
        detail={`pack 'little-remielle' declares animation 'thinking' but 思考.gif is missing`}
        retryLabel="重试"
        onRetry={() => {}}
      />
    );
  }

  if (scene === "menu") {
    return (
      <>
        <SpriteStandIn />
        {menuOpen && (
          <ContextMenu
            x={SPRITE.centreX - 150}
            y={SPRITE.centreY - 40}
            items={[
              { id: "pin", label: "定住位置", checked: false, onSelect: () => {} },
              { id: "top", label: "置于最上", checked: true, onSelect: () => {} },
              { id: "emote", label: "切换动作", onSelect: () => {} },
              { id: "new", label: "新聊天", onSelect: () => {} },
              { id: "quit", label: "退出", danger: true, onSelect: () => {} },
            ]}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <SpriteStandIn />
      <ChatPanel geometry={GEOMETRY} />
      {scene === "flight" && <FlightStill t={flightT} />}
    </>
  );
}

// Seed the store for the chosen scene before the first render.
const SCENES: Record<string, { messages: ChatMessage[]; draft: string; streaming: boolean }> = {
  conversation: { messages: CONVERSATION, draft: "", streaming: false },
  streaming: { messages: STREAMING, draft: "", streaming: true },
  empty: { messages: [], draft: "", streaming: false },
  composer: {
    messages: CONVERSATION.slice(0, 2),
    draft: "这是一段接近字数上限的输入，用来确认计数器会在剩余字符不多时出现，并且输入框会在长到一定高度后转为内部滚动，而不是把整个面板越撑越高。再多写一点、再多写一点，凑到阈值附近。",
    streaming: false,
  },
  stress: { messages: STRESS_MESSAGES, draft: "", streaming: true },
  flight: { messages: CONVERSATION, draft: "", streaming: false },
};

const seed = SCENES[scene] ?? SCENES["conversation"]!;
useChatStore.setState({ phase: "open", ...seed });

const container = document.getElementById("root");
if (!container) throw new Error("harness root element is missing");

createRoot(container).render(<Harness />);

if (scrollTo === "top") {
  // Defeat the panel's stick-to-bottom so the start of a transcript can be shot.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const scroller = document.querySelector(".panel__scroll");
      if (scroller) scroller.scrollTop = 0;
    });
  });
}
