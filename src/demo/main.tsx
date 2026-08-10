import "@/harness/tauriStub";

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { createSpring2D, isSettled2D, step2D } from "@/anim/spring";
import { startMockStream, type MockStreamHandle } from "@/lib/mockStream";
import { ContextMenu, type MenuItem } from "@/overlay/ContextMenu";
import { ChatPanel } from "@/overlay/chat/ChatPanel";
import { setSpriteFrame } from "@/overlay/spritePosition";
import { applyTheme } from "@/lib/theme";
import { restingState, useAgentStore } from "@/state/agent";
import { useChatStore, type ChatMessage } from "@/state/chat";
import { useConfigStore } from "@/state/config";
import "@/assets/fonts/noto-serif-sc.css";
import "@/styles/overlay.css";
import "@/styles/chat.css";
import "./demo.css";

/**
 * Browser demo.
 *
 * Runs the *real* panel, composer, message renderer, spring drag and close
 * flight — only the transport is faked. `start_chat` is intercepted and driven
 * by the mock stream instead of a provider, so what you click here is the code
 * that ships, not a mock-up of it.
 *
 * Not part of the app bundle; built only when BUILD_DEMO=1.
 */

/**
 * The real animations, when the build inlined them.
 *
 * Two of the seven — the whole pack is 19MB and base64 would put the page past
 * the host's ceiling. Enough to show a state change swapping the frame, and the
 * registration offsets holding her still while it happens.
 */
interface InlineSprite {
  src: string;
  offset: { x: number; y: number };
}

const SPRITES = ((window as { __REMIELLE_SPRITES__?: Record<string, InlineSprite> })
  .__REMIELLE_SPRITES__ ?? {}) as Record<string, InlineSprite>;

const FRAME = (window as { __REMIELLE_FRAME__?: { width: number; height: number } })
  .__REMIELLE_FRAME__ ?? { width: 260, height: 260 };

const HAS_SPRITES = Object.keys(SPRITES).length > 0;

const SPRITE = HAS_SPRITES
  ? { width: FRAME.width, height: FRAME.height }
  : { width: 260, height: 260 };

/**
 * Which frame to draw for a state.
 *
 * The same fallback chain the shipped `resolveAnimation` walks, cut down to the
 * two animations available here: a state with no frame of its own falls back to
 * idle rather than rendering nothing.
 */
function frameFor(state: string): InlineSprite | null {
  return SPRITES[state] ?? SPRITES["idle"] ?? null;
}

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

let active: MockStreamHandle | null = null;

function patchMessage(
  messages: ChatMessage[],
  id: string,
  patch: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((m) => (m.id === id ? patch(m) : m));
}

/** Applies the same state transitions the real event handler would. */
function driveMockStream(prompt: string): void {
  const target = useChatStore
    .getState()
    .messages.filter((m) => m.role === "assistant")
    .at(-1);
  if (!target) return;
  const id = target.id;

  const agent = useAgentStore.getState();
  agent.setState("thinking");

  active = startMockStream(prompt, {
    onReasoning: (chunk) =>
      useChatStore.setState((state) => ({
        messages: patchMessage(state.messages, id, (m) => ({
          ...m,
          reasoning: m.reasoning + chunk,
        })),
      })),

    onChunk: (chunk) => {
      if (useAgentStore.getState().state === "thinking") {
        useAgentStore.getState().setState("writing");
      }
      useChatStore.setState((state) => ({
        messages: patchMessage(state.messages, id, (m) => ({
          ...m,
          chunks: [...m.chunks, chunk],
        })),
      }));
    },

    onDone: () => {
      active = null;
      const usage = { prompt: 128, completion: 96, total: 224 };
      useChatStore.setState((state) => ({
        streaming: false,
        messages: patchMessage(state.messages, id, (m) => ({
          ...m,
          status: "done",
          usage,
          // A citation, so the tool-provenance row is visible in the demo.
          tools: [
            { kind: "search", query: "tauri transparent window click-through" },
            { kind: "citation", title: "Window Customization | Tauri", url: "https://v2.tauri.app/learn/window-customization/" },
          ],
        })),
        sessionUsage: {
          prompt: state.sessionUsage.prompt + usage.prompt,
          completion: state.sessionUsage.completion + usage.completion,
          total: state.sessionUsage.total + usage.total,
        },
      }));
      // Back to rest, with no celebration wedged in between.
      useAgentStore.getState().setState(restingState(true));
    },
  });
}

/**
 * Replays a tool round into the store the way the Rust loop would.
 *
 * Triggered by asking for something the catalog covers, so the transcript rows,
 * the confirmation prompt and the refusal path can all be exercised in a
 * browser with no Windows and no provider behind them.
 */
function scriptToolRun(prompt: string): boolean {
  const scan = /毒|扫描|scan|virus/i.test(prompt);
  const theme = /主题|深色|浅色|theme|dark|light/i.test(prompt);
  if (!scan && !theme) return false;

  const target = useChatStore
    .getState()
    .messages.filter((m) => m.role === "assistant")
    .at(-1);
  if (!target) return false;
  const id = target.id;

  const callId = `call_${Date.now()}`;
  const label = scan ? "运行 Windows Defender 病毒扫描" : "切换 Windows 明暗主题";

  const addRun = () =>
    useChatStore.setState((state) => ({
      messages: patchMessage(state.messages, id, (m) => ({
        ...m,
        toolRuns: [...m.toolRuns, { callId, tool: "demo", label, summary: null, ok: null }],
      })),
    }));

  const finishRun = (summary: string, ok: boolean) =>
    useChatStore.setState((state) => ({
      messages: patchMessage(state.messages, id, (m) => ({
        ...m,
        toolRuns: m.toolRuns.map((r) => (r.callId === callId ? { ...r, summary, ok } : r)),
      })),
    }));

  useAgentStore.getState().setState("thinking");
  setTimeout(addRun, 500);

  if (scan) {
    // Confirm tier: park on the prompt and wait for a real answer.
    setTimeout(() => {
      useChatStore.setState({
        confirm: { callId, tool: "security_scan", label, detail: "quick" },
      });
    }, 900);

    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (previous.confirm && !state.confirm) {
        unsubscribe();
        // The demo cannot see the answer, only that one was given; the panel
        // clears `confirm` either way. Approval is inferred from the store
        // patch the real command would have caused.
        const approved = (window as { __demoApproved?: boolean }).__demoApproved ?? false;
        finishRun(approved ? "跑完了一次 Defender 快速扫描" : "你拒绝了这次扫描", approved);
        driveMockStream(prompt);
      }
    });
    return true;
  }

  setTimeout(() => {
    finishRun("把 Windows 主题切换成了深色", true);
    driveMockStream(prompt);
  }, 1400);
  return true;
}

const internals = window.__TAURI_INTERNALS__ as Record<string, unknown>;
internals["invoke"] = async (command: string, args: Record<string, unknown>) => {
  if (command === "start_chat") {
    const request = args["request"] as { messages: { content: string }[] };
    const prompt = request.messages.at(-1)?.content ?? "";
    if (!scriptToolRun(prompt)) driveMockStream(prompt);
  }
  if (command === "cancel_chat") active?.cancel();
  if (command === "resolve_tool_confirm") {
    (window as { __demoApproved?: boolean }).__demoApproved = Boolean(args["approved"]);
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

/**
 * Stand-in for the character, with the real spring drag.
 *
 * The shipped app draws animation frames from an asset pack; the physics,
 * the hit box and the position the chat panel flies back into are identical.
 */
function Character({
  onActivate,
  onContextMenu,
}: {
  onActivate: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useAgentStore((s) => s.state);

  const spring = useRef(createSpring2D(window.innerWidth * 0.72, window.innerHeight * 0.6));
  const target = useRef({ x: window.innerWidth * 0.72, y: window.innerHeight * 0.6 });
  const drag = useRef({ active: false, id: -1, dx: 0, dy: 0, sx: 0, sy: 0, moved: false });

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = (now - previous) / 1000;
      previous = now;

      if (!isSettled2D(spring.current, target.current.x, target.current.y)) {
        step2D(spring.current, target.current.x, target.current.y, dt);
      }

      const x = spring.current.x.value;
      const y = spring.current.y.value;
      if (ref.current) {
        ref.current.style.transform = `translate3d(${x - SPRITE.width / 2}px, ${y - SPRITE.height / 2}px, 0)`;
      }
      setSpriteFrame({ centreX: x, centreY: y, width: SPRITE.width, height: SPRITE.height });
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      ref={ref}
      className={`figure figure--${state}`}
      style={{ width: SPRITE.width, height: SPRITE.height }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      onPointerDown={(event) => {
        // Left button only, matching `Sprite`. Without this the right-click
        // that opens the menu also runs the click-to-open-chat path on release.
        if (event.button !== 0) return;
        drag.current = {
          active: true,
          id: event.pointerId,
          dx: event.clientX - spring.current.x.value,
          dy: event.clientY - spring.current.y.value,
          sx: event.clientX,
          sy: event.clientY,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d.active || event.pointerId !== d.id) return;
        if (Math.abs(event.clientX - d.sx) > 4 || Math.abs(event.clientY - d.sy) > 4) {
          d.moved = true;
        }
        target.current = { x: event.clientX - d.dx, y: event.clientY - d.dy };
      }}
      onPointerUp={(event) => {
        const d = drag.current;
        if (!d.active || event.pointerId !== d.id) return;
        d.active = false;
        if (!d.moved) onActivate();
      }}
    >
      {frameFor(state) ? (
        <img
          className="figure__frame"
          src={frameFor(state)!.src}
          alt=""
          draggable={false}
          style={{
            transform: `translate(-50%, -50%) translate(${frameFor(state)!.offset.x}px, ${
              frameFor(state)!.offset.y
            }px)`,
          }}
        />
      ) : (
        <>
          <div className="figure__head" />
          <div className="figure__body" />
        </>
      )}
      <span className="figure__state">{state}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Demo() {
  const phase = useChatStore((s) => s.phase);
  const [hint, setHint] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState(false);
  const [onTop, setOnTop] = useState(true);

  const geometry = {
    width: window.innerWidth,
    height: window.innerHeight,
    scaleFactor: 1,
    monitor: "demo",
  };

  const activate = useCallback(() => {
    setHint(false);
    const chat = useChatStore.getState();
    if (chat.phase === "closed") chat.openPanel();
    else chat.requestClose();
  }, []);

  // The same right-click menu the app puts on the character. Pin and
  // always-on-top are local state here — there is no window to apply them to in
  // a browser — but the menu itself, its tick marks and its edge-flipping are
  // the shipped component.
  const menuItems: MenuItem[] = [
    { id: "pin", label: "定住位置", checked: pinned, onSelect: () => setPinned((v) => !v) },
    { id: "top", label: "置于最上", checked: onTop, onSelect: () => setOnTop((v) => !v) },
    {
      id: "emote",
      label: "切换动作",
      onSelect: () => {
        const order = ["idle", "penIdle", "thinking", "writing", "expect", "pleased"] as const;
        const now = useAgentStore.getState().state;
        const next = order[(order.indexOf(now as (typeof order)[number]) + 1) % order.length]!;
        useAgentStore.getState().setState(next);
      },
    },
    {
      id: "new-chat",
      label: "新聊天",
      onSelect: () => {
        const chat = useChatStore.getState();
        if (chat.phase === "closed") chat.openPanel();
        else chat.reset();
      },
    },
    {
      id: "theme",
      label: "换配色（浅色/深色）",
      onSelect: () => {
        const root = document.documentElement;
        const next = root.dataset["theme"] === "light" ? "dark" : "light";
        root.dataset["theme"] = next;
        useChatStore.getState().notify(next === "light" ? "换成浅色了" : "换回深色了");
      },
    },
    { id: "settings", label: "设置", onSelect: () => useChatStore.getState().notify("演示里没有设置窗口") },
  ];

  return (
    <>
      {phase !== "closed" && <ChatPanel geometry={geometry} />}
      <Character
        onActivate={activate}
        onContextMenu={(x, y) => {
          setHint(false);
          setMenu({ x, y });
        }}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {hint && (
        <div className="hint">
          <p className="hint__line">点她一下打开聊天，拖动她试试弹簧手感，右键看菜单。</p>
          <p className="hint__line hint__line--dim">
            试着说「帮我查个毒」或「切成深色主题」，看她怎么用工具、什么时候会停下来问你。
          </p>
          <p className="hint__line hint__line--dim">
            关闭聊天框时留意它怎么飞回去 —— 模糊、挤压、抛物线，最后消失在她背后。
          </p>
        </div>
      )}
    </>
  );
}

// Config is faked so the panel considers itself ready to send.
useConfigStore.setState({
  hydrated: true,
  provider: "deepseek",
  model: "deepseek-reasoner",
  configured: ["deepseek"],
  webSearch: true,
  providers: [
    {
      id: "deepseek",
      label: "DeepSeek",
      protocol: "openAiCompatible",
      defaultBaseUrl: "",
      keyPrefix: "sk-",
      requiresKey: true,
      // Enabled here so the web-search toggle is visible to try.
      nativeSearch: true,
      docsUrl: "",
    },
  ],
});

// The demo has no settings window, so it starts on the same default the app
// does: follow the system.
applyTheme("auto");

const container = document.getElementById("root");
if (!container) throw new Error("demo root element is missing");
createRoot(container).render(<Demo />);

// Debug handle for driving the store from a browser console; dev-demo only.
(window as unknown as { __chat?: typeof useChatStore }).__chat = useChatStore;
