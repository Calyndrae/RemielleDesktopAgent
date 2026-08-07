/**
 * The most recent conversation, kept on this machine.
 *
 * Exactly one is stored, under the app's own data directory alongside the
 * settings — nothing is uploaded, and nothing is kept once the user turns the
 * setting off. Older transcripts are not accumulated: a companion quietly
 * building an archive of everything you ever said to it is not what anyone
 * asked for, and one "carry on from where we left off" covers the actual need.
 *
 * Reasoning is stored too. This copy never leaves the machine, so the argument
 * for stripping it (see `exportSession`) does not apply — and dropping it would
 * make a resumed conversation look different from the one you left.
 */

import { readSetting, writeSetting } from "@/lib/persist";
import type { ChatMessage } from "@/state/chat";

const KEY = "lastSession";

/** Bump when the stored shape changes incompatibly. */
const VERSION = 1;

export interface StoredSession {
  version: number;
  savedAt: number;
  messages: ChatMessage[];
}

/** Messages worth keeping: failures and empty turns would only be noise. */
function usable(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (m) => m.status !== "error" && m.chunks.join("").trim().length > 0,
  );
}

export async function saveLastSession(messages: ChatMessage[]): Promise<void> {
  const keep = usable(messages);
  if (keep.length === 0) return;
  await writeSetting<StoredSession>(KEY, {
    version: VERSION,
    savedAt: Date.now(),
    messages: keep,
  });
}

export async function clearLastSession(): Promise<void> {
  await writeSetting<StoredSession | null>(KEY, null);
}

/**
 * Reads the stored conversation back.
 *
 * Returns null rather than throwing for anything unexpected — a store written
 * by a newer build, a hand-edited file, a half-written row. A companion that
 * refuses to open because its history file is odd is worse than one that
 * quietly starts fresh.
 */
export async function loadLastSession(): Promise<StoredSession | null> {
  const stored = await readSetting<StoredSession | null>(KEY, null);
  if (!stored || typeof stored !== "object") return null;
  if (stored.version !== VERSION) return null;
  if (!Array.isArray(stored.messages) || stored.messages.length === 0) return null;

  const messages = stored.messages.filter(
    (m): m is ChatMessage =>
      !!m &&
      (m.role === "user" || m.role === "assistant") &&
      Array.isArray(m.chunks),
  );
  if (messages.length === 0) return null;

  return { ...stored, messages };
}

/** "3 分钟前" / "昨天" — how long ago the stored conversation was left. */
export function describeAge(savedAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - savedAt) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "昨天" : `${days} 天前`;
}
