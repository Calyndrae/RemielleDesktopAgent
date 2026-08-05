/**
 * Minimal i18n. Deliberately not a library: the message set is small, and the
 * app already has to know the system locale in order to tell the model about it.
 */

import { zhCN } from "./zh-CN";
import { en } from "./en";

export type Messages = typeof zhCN;
export type Locale = "zh-CN" | "en";

const CATALOGS: Record<Locale, Messages> = {
  "zh-CN": zhCN,
  en,
};

export const DEFAULT_LOCALE: Locale = "zh-CN";

/** Maps a BCP-47 tag onto a catalog, falling back to Simplified Chinese. */
export function resolveLocale(tag: string | null | undefined): Locale {
  if (!tag) return DEFAULT_LOCALE;
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

export function getMessages(locale: Locale): Messages {
  return CATALOGS[locale];
}

/**
 * Picks the best display label from a pack's per-locale label map.
 * Packs are third-party data, so every step here has to tolerate absence.
 */
export function pickLabel(
  labels: Record<string, string>,
  locale: Locale,
  fallback: string,
): string {
  return labels[locale] ?? labels[DEFAULT_LOCALE] ?? labels["en"] ?? fallback;
}
