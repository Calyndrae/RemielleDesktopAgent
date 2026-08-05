import { create } from "zustand";

import { startMockStream, type MockStreamHandle } from "@/lib/mockStream";
import { useAgentStore } from "./agent";

/** Hard cap on a single user message. */
export const MAX_INPUT_LENGTH = 500;

/** Show the counter only once the user is near the limit. */
export const COUNTER_THRESHOLD = MAX_INPUT_LENGTH - 60;

/** How long the character looks pleased before returning to idle. */
const PLEASED_DURATION_MS = 1500;

export type MessageRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  /**
   * Text split at the boundaries it arrived on. Rendering per chunk is what
   * lets each one fade in from blur independently; joining them first would
   * lose the seams and re-animate the whole message on every update.
   */
  chunks: string[];
  /**
   * Chain-of-thought, kept separate from the answer. Providers deliver this
   * either as its own field (DeepSeek's `reasoning_content`) or wrapped in
   * `<think>` tags inside the body; either way the user must be able to see it.
   */
  reasoning: string;
  status: "streaming" | "done" | "cancelled";
  createdAt: number;
}

/** Collapsed label for the reasoning row: its first sentence, truncated. */
export function reasoningSummary(reasoning: string): string {
  const firstSentence = reasoning.split(/(?<=[。？！.?!])\s*/)[0] ?? reasoning;
  const trimmed = firstSentence.trim();
  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed;
}

export type PanelPhase = "closed" | "opening" | "open" | "closing";

interface ChatStore {
  phase: PanelPhase;
  messages: ChatMessage[];
  draft: string;
  streaming: boolean;

  openPanel: () => void;
  finishOpen: () => void;
  /** Begins the close animation; `finishClose` completes it. */
  requestClose: () => void;
  finishClose: () => void;

  setDraft: (draft: string) => void;
  send: () => void;
  stop: () => void;
  /** Discards the last reply and asks again with the same prompt. */
  regenerate: () => void;
  reset: () => void;
}

type SetState = (
  partial:
    | Partial<ChatStore>
    | ((state: ChatStore) => Partial<ChatStore>),
) => void;

let activeStream: MockStreamHandle | null = null;
let pleasedTimer: ReturnType<typeof setTimeout> | undefined;

const messageText = (message: ChatMessage) => message.chunks.join("");

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

function stopActiveStream(): void {
  activeStream?.cancel();
  activeStream = null;
}

/** Applies `patch` to one message, leaving the rest untouched. */
function patchMessage(
  messages: ChatMessage[],
  id: string,
  patch: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((message) => (message.id === id ? patch(message) : message));
}

/**
 * Appends an empty assistant turn and streams a reply into it.
 *
 * Shared by `send` and `regenerate` so both drive the character's state machine
 * the same way: thinking while the chain-of-thought arrives, writing once body
 * text starts, pleased briefly on completion.
 */
function beginReply(set: SetState, prompt: string): void {
  const assistantId = nextId();

  set((state) => ({
    streaming: true,
    messages: [
      ...state.messages,
      {
        id: assistantId,
        role: "assistant" as const,
        chunks: [],
        reasoning: "",
        status: "streaming" as const,
        createdAt: Date.now(),
      },
    ],
  }));

  useAgentStore.getState().setState("thinking");

  activeStream = startMockStream(prompt, {
    onReasoning: (text) => {
      set((state) => ({
        messages: patchMessage(state.messages, assistantId, (message) => ({
          ...message,
          reasoning: message.reasoning + text,
        })),
      }));
    },

    onChunk: (text) => {
      // The first chunk of body text is the moment she stops thinking and
      // starts writing.
      if (useAgentStore.getState().state === "thinking") {
        useAgentStore.getState().setState("writing");
      }
      set((state) => ({
        messages: patchMessage(state.messages, assistantId, (message) => ({
          ...message,
          chunks: [...message.chunks, text],
        })),
      }));
    },

    onDone: () => {
      activeStream = null;
      set((state) => ({
        streaming: false,
        messages: patchMessage(state.messages, assistantId, (message) => ({
          ...message,
          status: "done" as const,
        })),
      }));

      useAgentStore.getState().setState("pleased");
      clearTimeout(pleasedTimer);
      pleasedTimer = setTimeout(() => {
        // Only fall back to the panel's resting animation if nothing else has
        // taken over in the meantime.
        if (useAgentStore.getState().state === "pleased") {
          useAgentStore.getState().setState("penIdle");
        }
      }, PLEASED_DURATION_MS);
    },
  });
}

export const useChatStore = create<ChatStore>((set, get) => ({
  phase: "closed",
  messages: [],
  draft: "",
  streaming: false,

  openPanel: () => {
    if (get().phase !== "closed") return;
    set({ phase: "opening" });
    useAgentStore.getState().setState("penIdle");
  },

  finishOpen: () => {
    if (get().phase === "opening") set({ phase: "open" });
  },

  requestClose: () => {
    const { phase } = get();
    if (phase !== "open" && phase !== "opening") return;
    stopActiveStream();
    set({ phase: "closing", streaming: false });
  },

  finishClose: () => {
    clearTimeout(pleasedTimer);
    // Sessions are not kept by default, so closing the panel discards the
    // conversation. The save prompt arrives in M4.
    set({ phase: "closed", messages: [], draft: "", streaming: false });
    useAgentStore.getState().setState("idle");
  },

  setDraft: (draft) => set({ draft: draft.slice(0, MAX_INPUT_LENGTH) }),

  send: () => {
    const { draft, streaming } = get();
    const prompt = draft.trim();
    if (!prompt || streaming) return;

    set((state) => ({
      draft: "",
      messages: [
        ...state.messages,
        {
          id: nextId(),
          role: "user" as const,
          chunks: [prompt],
          reasoning: "",
          status: "done" as const,
          createdAt: Date.now(),
        },
      ],
    }));

    beginReply(set, prompt);
  },

  stop: () => {
    if (!get().streaming) return;
    stopActiveStream();
    set((state) => ({
      streaming: false,
      messages: state.messages.map((message) =>
        message.status === "streaming"
          ? {
              ...message,
              // A reply that produced text is worth keeping; one cut off before
              // its first token is not.
              status: messageText(message).length > 0 ? "done" : "cancelled",
            }
          : message,
      ),
    }));
    useAgentStore.getState().setState("penIdle");
  },

  regenerate: () => {
    const { messages, streaming } = get();
    if (streaming) return;

    // Drop trailing assistant turns, then reuse the user prompt beneath them.
    let end = messages.length;
    while (end > 0 && messages[end - 1]?.role === "assistant") end -= 1;

    const prompt = messages[end - 1];
    if (!prompt || prompt.role !== "user") return;

    set({ messages: messages.slice(0, end) });
    beginReply(set, messageText(prompt));
  },

  reset: () => {
    stopActiveStream();
    clearTimeout(pleasedTimer);
    set({ messages: [], draft: "", streaming: false });
    useAgentStore.getState().setState("penIdle");
  },
}));
