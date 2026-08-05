import "./tauriStub";

import { createRoot } from "react-dom/client";

import { ChatPanel } from "@/overlay/chat/ChatPanel";
import { setSpriteFrame } from "@/overlay/spritePosition";
import { useChatStore, type ChatMessage } from "@/state/chat";
import "@/styles/overlay.css";
import "@/styles/chat.css";

/**
 * Layout harness.
 *
 * Mounts the chat panel in an ordinary browser page with content chosen to
 * break flex layouts, so the panel can be screenshotted and asserted against
 * without a Windows machine or a running Tauri host. Not part of the shipped
 * app — see the `BUILD_HARNESS` guard in vite.config.ts.
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
): ChatMessage {
  return { id, role, chunks: [text], status, createdAt: Date.now() };
}

const seeded: ChatMessage[] = [
  message("u1", "user", "嗨"),
  message("a1", "assistant", "嗯？这么快就来找我了。\n\n我还以为你会多犹豫一会儿呢~"),
  message(
    "u2",
    "user",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ),
  message("a2", "assistant", STRESS),
  message("u3", "user", "🌟"),
  message("a3", "assistant", "好呀~", "streaming"),
];

// Put the character bottom-right so the panel resolves to its left.
setSpriteFrame({ centreX: 1500, centreY: 620, width: 300, height: 300 });

useChatStore.setState({
  phase: "open",
  messages: seeded,
  draft: "",
  streaming: true,
});

const container = document.getElementById("root");
if (!container) throw new Error("harness root element is missing");

createRoot(container).render(
  <ChatPanel
    geometry={{
      width: window.innerWidth,
      height: window.innerHeight,
      scaleFactor: 1,
      monitor: "harness",
    }}
  />,
);
