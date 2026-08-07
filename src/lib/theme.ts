/**
 * Which palette the floating panel uses.
 *
 * `auto` is resolved here in JS rather than in a media query, so the stylesheet
 * only ever sees a concrete `light` or `dark`. Doing it the other way would mean
 * writing the whole light palette twice — once under
 * `@media (prefers-color-scheme: light)` for the automatic case and once under
 * an attribute selector for the explicit one — and two copies of a palette is
 * two places for it to drift.
 */

export type PanelTheme = "auto" | "light" | "dark";

export type ResolvedTheme = "light" | "dark";

const QUERY = "(prefers-color-scheme: light)";

/** What `auto` currently means. Dark when the system will not say. */
export function systemTheme(): ResolvedTheme {
  return globalThis.matchMedia?.(QUERY).matches ? "light" : "dark";
}

export function resolveTheme(theme: PanelTheme): ResolvedTheme {
  return theme === "auto" ? systemTheme() : theme;
}

/** Stamps the resolved theme on the document root, where the CSS reads it. */
export function applyTheme(theme: PanelTheme): ResolvedTheme {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset["theme"] = resolved;
  return resolved;
}

/**
 * Keeps `auto` following the system while it is selected.
 *
 * The listener is attached whatever the setting is and simply does nothing for
 * an explicit choice, so switching back to `auto` does not need the caller to
 * re-subscribe.
 */
export function watchSystemTheme(current: () => PanelTheme): () => void {
  const media = globalThis.matchMedia?.(QUERY);
  if (!media) return () => {};

  const onChange = () => {
    if (current() === "auto") applyTheme("auto");
  };

  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
