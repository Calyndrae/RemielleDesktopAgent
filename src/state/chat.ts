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
  status: "streaming" | "done" | "cancelled";
  createdAt: number;
}

export type PanelPhase = "closed" | "opening" | "open" | "closing";

interface ChatStore {
  phase: PanelPhase;
  messages: ChatMessage[];
  draft: string;
  streaming: boolean;

  openPanel: () => void;
  /** Begins the close animation; `finishClose` completes it. */
  requestClose: () => void;
  finishClose: () => void;
  finishOpen: () => void;

  setDraft: (draft: string) => void;
  send: () => void;
  stop: () => void;
  reset: () => void;
}

let activeStream: MockStreamHandle | null = null;
let pleasedTimer: ReturnType<typeof setTimeout> | undefined;

const messageText = (message: ChatMessage) => message.chunks.join("");

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

function stopActiveStream(): void {
  activeStream?.cancel();
  activeStream = null;
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

    const assistantId = nextId();
    const now = Date.now();

    set((state) => ({
      draft: "",
      streaming: true,
      messages: [
        ...state.messages,
        {
          id: nextId(),
          role: "user",
          chunks: [prompt],
          status: "done",
          createdAt: now,
        },
        {
          id: assistantId,
          role: "assistant",
          chunks: [],
          status: "streaming",
          createdAt: now,
        },
      ],
    }));

    useAgentStore.getState().setState("thinking");

    activeStream = startMockStream(prompt, {
      onChunk: (text) => {
        // The first chunk of body text is the moment she stops thinking and
        // starts writing.
        if (useAgentStore.getState().state === "thinking") {
          useAgentStore.getState().setState("writing");
        }
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === assistantId
              ? { ...message, chunks: [...message.chunks, text] }
              : message,
          ),
        }));
      },
      onDone: () => {
        activeStream = null;
        set((state) => ({
          streaming: false,
          messages: state.messages.map((message) =>
            message.id === assistantId ? { ...message, status: "done" } : message,
          ),
        }));

        const agent = useAgentStore.getState();
        agent.setState("pleased");
        clearTimeout(pleasedTimer);
        pleasedTimer = setTimeout(() => {
          // Only fall back to the panel's resting animation if nothing else
          // has taken over in the meantime.
          if (useAgentStore.getState().state === "pleased") {
            useAgentStore.getState().setState("penIdle");
          }
        }, PLEASED_DURATION_MS);
      },
    });
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
              status: messageText(message).length > 0 ? "done" : "cancelled",
            }
          : message,
      ),
    }));
    useAgentStore.getState().setState("penIdle");
  },

  reset: () => {
    stopActiveStream();
    clearTimeout(pleasedTimer);
    set({ messages: [], draft: "", streaming: false });
    useAgentStore.getState().setState("penIdle");
  },
}));
