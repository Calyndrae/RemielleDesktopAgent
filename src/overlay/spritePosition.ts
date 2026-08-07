/**
 * The sprite's live geometry, in overlay logical pixels.
 *
 * Deliberately module-level mutable state rather than React state: the sprite's
 * animation loop writes this every frame, and routing 60 updates a second
 * through a store would re-render the whole overlay for no reason. Consumers
 * are themselves frame loops (the panel's close animation) and read it on
 * demand.
 */

export interface SpriteFrame {
  centreX: number;
  centreY: number;
  width: number;
  height: number;
}

const frame: SpriteFrame = { centreX: 0, centreY: 0, width: 0, height: 0 };

export function setSpriteFrame(next: SpriteFrame): void {
  frame.centreX = next.centreX;
  frame.centreY = next.centreY;
  frame.width = next.width;
  frame.height = next.height;
}

export function getSpriteFrame(): Readonly<SpriteFrame> {
  return frame;
}
