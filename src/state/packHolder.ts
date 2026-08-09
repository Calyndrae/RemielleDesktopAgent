import { create } from "zustand";

import type { PackManifest } from "@/types/pack";

/**
 * The loaded animation pack, readable from anywhere.
 *
 * The pack is loaded once in `App` and was only ever passed down as props,
 * which was fine until the composer's slash palette needed the animation list
 * for `/emote` — three components away from the load site with nothing in
 * between wanting it. A one-field store beats threading a prop through a
 * hierarchy that otherwise has no use for it.
 */
interface PackHolder {
  pack: PackManifest | null;
  setPack: (pack: PackManifest | null) => void;
}

export const usePackStore = create<PackHolder>((set) => ({
  pack: null,
  setPack: (pack) => set({ pack }),
}));
