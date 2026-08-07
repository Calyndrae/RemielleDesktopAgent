import { onSettingChanged } from "@/lib/persist";
import { useAmbientStore } from "./ambient";
import { useConfigStore } from "./config";
import { useSpriteStore } from "./sprite";

/**
 * Keeps the overlay and the settings window agreeing.
 *
 * Each has its own copy of every store, both read and write the same file, and
 * until this existed neither noticed the other doing it: changing her size, the
 * model, or which tools she may use saved correctly and then appeared to do
 * nothing, because the window that had to act on it was still holding the value
 * it read at startup.
 *
 * Re-reading the whole store is deliberate rather than applying a diff. These
 * are small objects read from a local file, the hydrate paths already exist and
 * are already careful about defaults, and a merge would be a second place for
 * the shape of each setting to be described — and to drift.
 */
const WATCHED = [
  "ai.config",
  "sprite.placement",
  "ambient",
  "ambientState",
] as const;

export function attachSettingsSync(): Promise<() => void> {
  return onSettingChanged(WATCHED, (key) => {
    switch (key) {
      case "ai.config":
        void useConfigStore.getState().hydrate();
        break;
      case "sprite.placement":
        void useSpriteStore.getState().hydrate();
        break;
      case "ambient":
      case "ambientState":
        void useAmbientStore.getState().hydrate();
        break;
    }
  });
}
