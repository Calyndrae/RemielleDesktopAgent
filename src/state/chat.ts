import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  CHAT_EVENT,
  ipc,
  type ApiError,
  type StreamEvent,
  type TokenUsage,
  type ToolActivity,
} from "@/lib/ipc";
import { cancelPendingState, restingState, useAgentStore } from "./agent";
import { clearLastSession, saveLastSession } from "@/lib/lastSession";
import { useConfigStore } from "./config";

/** Hard cap on a single user message. */
export const MAX_INPUT_LENGTH = 500;

/** Show the counter only once the user is near the limit. */
export const COUNTER_THRESHOLD = MAX_INPUT_LENGTH - 60;

/** Turns sent as context. Older ones are dropped rather than growing forever. */
const CONTEXT_TURNS = 20;

export type MessageRole = "user" | "assistant";

/** One catalog tool she asked for, and how it went. */
export interface ToolRun {
  callId: string;
  tool: string;
  /** The catalog's user-facing label. The raw tool name is never shown. */
  label: string;
  /** Plain-language outcome; absent while the call is still in flight. */
  summary: string | null;
  /** null = still running or waiting on you. */
  ok: boolean | null;
}

/** A `Confirm`-tier call waiting on the user. Only ever one at a time. */
export interface PendingConfirm {
  callId: string;
  tool: string;
  label: string;
  detail: string;
}

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
  /**
   * What the model did besides write — searches run, sources consulted.
   * Rendered in the transcript so "did it look this up?" is answerable by
   * looking, not by guessing from the wording.
   */
  tools: ToolActivity[];
  /**
   * Tools she actually ran this turn, in order.
   *
   * Separate from `tools` above, which is the provider's *own* web search. This
   * is the catalog: things that touched the machine. The user has to be able to
   * see every one of them after the fact, including the ones that were refused.
   */
  toolRuns: ToolRun[];
  usage: TokenUsage | null;
  error: ApiError | null;
  status: "streaming" | "done" | "cancelled" | "error";
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
  /** Running total for this conversation, so cost is never a surprise. */
  sessionUsage: TokenUsage;
  /**
   * Transient confirmation line, shown over the composer.
   *
   * Actions whose whole result leaves the app — copying a transcript, writing a
   * file — otherwise complete in total silence, which is indistinguishable from
   * having done nothing.
   */
  toast: string | null;
  /** The confirmation prompt currently on screen, if any. */
  confirm: PendingConfirm | null;

  openPanel: () => void;
  finishOpen: () => void;
  requestClose: () => void;
  finishClose: () => void;

  setDraft: (draft: string) => void;
  send: () => void;
  stop: () => void;
  regenerate: () => void;
  reset: () => void;
  notify: (text: string) => void;
  /** Answers the pending confirmation. */
  answerConfirm: (approved: boolean) => void;
  /** Replaces the transcript with a previously stored one. */
  restore: (messages: ChatMessage[]) => void;
}

const EMPTY_USAGE: TokenUsage = { prompt: 0, completion: 0, total: 0 };

type SetState = (
  partial: Partial<ChatStore> | ((state: ChatStore) => Partial<ChatStore>),
) => void;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let activeStreamId: string | null = null;

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

const messageText = (message: ChatMessage) => message.chunks.join("");

function patchMessage(
  messages: ChatMessage[],
  id: string,
  patch: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((message) => (message.id === id ? patch(message) : message));
}

function emptyAssistant(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    chunks: [],
    reasoning: "",
    tools: [],
    toolRuns: [],
    usage: null,
    error: null,
    status: "streaming",
    createdAt: Date.now(),
  };
}

/**
 * Starts a reply and streams it in.
 *
 * The request is built here, but the API key is not: Rust reads it from the OS
 * credential store when it builds the HTTP request. Nothing secret passes
 * through this function.
 */
function beginReply(set: SetState, get: () => ChatStore): void {
  const config = useConfigStore.getState();
  const assistantId = nextId();
  const streamId = `s${Date.now()}-${assistantId}`;
  activeStreamId = streamId;

  set((state) => ({
    streaming: true,
    messages: [...state.messages, emptyAssistant(assistantId)],
  }));

  useAgentStore.getState().setState("thinking");

  // Only the tail of the conversation is sent; an unbounded transcript would
  // grow the bill on every turn.
  const history = get()
    .messages.filter((m) => m.status !== "error" && messageText(m).length > 0)
    .slice(-CONTEXT_TURNS)
    .map((m) => ({ role: m.role, content: messageText(m) }));

  void ipc
    .startChat(streamId, {
      provider: config.provider,
      baseUrl: config.baseUrl.trim() || null,
      model: config.model,
      messages: history,
      system: config.systemPrompt.trim() || null,
      temperature: config.temperature,
      /*
       * One flag, read by Rust in two ways: a provider with native search gets
       * its own mechanism switched on in the request body; everyone else gets
       * the preflight — router, search, results injected as context. Which one
       * runs is Rust's problem, not this file's.
       */
      webSearch: config.webSearch,
      tools: config.tools,
      appAllowlist: config.appAllowlist,
      searchEngineId: config.searchEngineId,
    })
    .catch((error: unknown) => {
      failStream(set, assistantId, error as ApiError);
    });

  streamTargets.set(streamId, assistantId);
}

/** Maps a stream id to the message it is filling. */
const streamTargets = new Map<string, string>();

/**
 * Returns the character to rest once a turn ends.
 *
 * Derived from where the panel is, not hard-coded: closing the panel mid-reply
 * has to land on the desktop idle, finishing a reply with the panel still open
 * has to land on the pen idle. Nothing is queued behind a timer.
 */
function settleCharacter(): void {
  const open = useChatStore.getState().phase !== "closed";
  useAgentStore.getState().setState(restingState(open));
}

function failStream(set: SetState, assistantId: string, error: ApiError): void {
  set((state) => ({
    streaming: false,
    messages: patchMessage(state.messages, assistantId, (message) => ({
      ...message,
      status: "error",
      error,
    })),
  }));
  // The character reacts rather than a raw dialog appearing over the desktop.
  useAgentStore.getState().setState("confused");
}

export const useChatStore = create<ChatStore>((set, get) => ({
  phase: "closed",
  messages: [],
  draft: "",
  streaming: false,
  sessionUsage: EMPTY_USAGE,
  toast: null,
  confirm: null,

  openPanel: () => {
    if (get().phase !== "closed") return;
    set({ phase: "opening" });
    // Her idle behaviour holds where it is for as long as the panel is open.
    useAgentStore.getState().suspendAmbient(true);
    useAgentStore.getState().setState("penIdle");
  },

  finishOpen: () => {
    if (get().phase === "opening") set({ phase: "open" });
  },

  requestClose: () => {
    const { phase } = get();
    if (phase !== "open" && phase !== "opening") return;
    get().stop();
    set({ phase: "closing", streaming: false });
  },

  finishClose: () => {
    clearTimeout(toastTimer);
    cancelPendingState();

    /*
     * Where the conversation goes.
     *
     * Kept on this machine by default, so "carry on from before" works; the
     * user can turn that off in settings, and turning it off also removes what
     * was already stored rather than merely stopping new writes. A privacy
     * switch that leaves the old data behind is not a privacy switch.
     */
    const { historyMode } = useConfigStore.getState();
    const { messages } = get();
    if (historyMode === "keep") void saveLastSession(messages);
    else void clearLastSession();

    set({
      phase: "closed",
      messages: [],
      draft: "",
      streaming: false,
      sessionUsage: EMPTY_USAGE,
      toast: null,
      confirm: null,
    });
    useAgentStore.getState().suspendAmbient(false);
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
          tools: [],
          toolRuns: [],
          usage: null,
          error: null,
          status: "done" as const,
          createdAt: Date.now(),
        },
      ],
    }));

    beginReply(set, get);
  },

  stop: () => {
    if (activeStreamId) {
      void ipc.cancelChat(activeStreamId);
    }
    if (!get().streaming) return;

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

    let end = messages.length;
    while (end > 0 && messages[end - 1]?.role === "assistant") end -= 1;
    if (!messages[end - 1] || messages[end - 1]?.role !== "user") return;

    set({ messages: messages.slice(0, end) });
    beginReply(set, get);
  },

  reset: () => {
    get().stop();
    set({
      messages: [],
      draft: "",
      streaming: false,
      sessionUsage: EMPTY_USAGE,
      toast: null,
      confirm: null,
    });
    useAgentStore.getState().setState("penIdle");
  },

  restore: (messages) => {
    const sessionUsage = messages.reduce<TokenUsage>(
      (total, message) =>
        message.usage
          ? {
              prompt: total.prompt + message.usage.prompt,
              completion: total.completion + message.usage.completion,
              total: total.total + message.usage.total,
            }
          : total,
      EMPTY_USAGE,
    );
    set({ messages, sessionUsage, draft: "" });
  },

  answerConfirm: (approved) => {
    const pending = get().confirm;
    if (!pending) return;
    set({ confirm: null });
    void ipc.resolveToolConfirm(pending.callId, approved);
  },

  notify: (text) => {
    clearTimeout(toastTimer);
    set({ toast: text });
    toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },
}));

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

let unlisten: UnlistenFn | null = null;

/** Subscribes to provider stream events. Call once at overlay startup. */
export async function attachChatEvents(): Promise<void> {
  if (unlisten) return;

  unlisten = await listen<StreamEvent>(CHAT_EVENT, ({ payload }) => {
    const assistantId = streamTargets.get(payload.streamId);
    if (!assistantId) return;

    const set = useChatStore.setState;

    switch (payload.type) {
      case "content": {
        if (useAgentStore.getState().state === "thinking") {
          useAgentStore.getState().setState("writing");
        }
        set((state) => ({
          messages: patchMessage(state.messages, assistantId, (message) => ({
            ...message,
            chunks: [...message.chunks, payload.text],
          })),
        }));
        break;
      }

      case "reasoning": {
        set((state) => ({
          messages: patchMessage(state.messages, assistantId, (message) => ({
            ...message,
            reasoning: message.reasoning + payload.text,
          })),
        }));
        break;
      }

      case "tool": {
        set((state) => ({
          messages: patchMessage(state.messages, assistantId, (message) => ({
            ...message,
            tools: [...message.tools, payload.activity],
          })),
        }));
        break;
      }

      case "toolCall": {
        set((state) => ({
          messages: patchMessage(state.messages, assistantId, (message) => ({
            ...message,
            toolRuns: [
              ...message.toolRuns,
              {
                callId: payload.callId,
                tool: payload.tool,
                label: payload.label,
                summary: null,
                ok: null,
              },
            ],
          })),
        }));
        break;
      }

      case "toolResult": {
        set((state) => ({
          messages: patchMessage(state.messages, assistantId, (message) => ({
            ...message,
            toolRuns: message.toolRuns.map((run) =>
              run.callId === payload.callId
                ? { ...run, summary: payload.summary, ok: payload.ok }
                : run,
            ),
          })),
        }));
        break;
      }

      case "toolConfirm": {
        set({
          confirm: {
            callId: payload.callId,
            tool: payload.tool,
            label: payload.label,
            detail: payload.detail,
          },
        });
        break;
      }

      case "usage": {
        set((state) => ({
          messages: patchMessage(state.messages, assistantId, (message) => ({
            ...message,
            usage: payload.usage,
          })),
          sessionUsage: {
            prompt: state.sessionUsage.prompt + payload.usage.prompt,
            completion: state.sessionUsage.completion + payload.usage.completion,
            total: state.sessionUsage.total + payload.usage.total,
          },
        }));
        break;
      }

      case "done": {
        streamTargets.delete(payload.streamId);
        if (activeStreamId === payload.streamId) activeStreamId = null;
        set((state) => ({
          streaming: false,
          confirm: null,
          messages: patchMessage(state.messages, assistantId, (message) => ({
            ...message,
            status: message.status === "streaming" ? "done" : message.status,
          })),
        }));
        settleCharacter();
        break;
      }

      case "failed": {
        streamTargets.delete(payload.streamId);
        if (activeStreamId === payload.streamId) activeStreamId = null;
        set({ confirm: null });
        failStream(set, assistantId, payload.error);
        break;
      }
    }
  });
}
