import type { RevylInput } from "@t3tools/contracts";

/** Movement below this many screen pixels is a tap, not a swipe. */
const DRAG_THRESHOLD_PX = 10;
const LONG_PRESS_MS = 500;

export interface GestureBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A pointer position in the device's own points, clamped to the screen. */
export function devicePoint(
  box: GestureBox,
  screen: { readonly width: number; readonly height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const clamp = (value: number, max: number) => Math.min(Math.max(Math.round(value), 0), max - 1);
  return {
    x: clamp(((clientX - box.left) / box.width) * screen.width, screen.width),
    y: clamp(((clientY - box.top) / box.height) * screen.height, screen.height),
  };
}

/**
 * What a press on the device's picture means: a tap, a long press when held, or a swipe from
 * where it started in the direction the pointer mostly moved.
 */
export function revylGesture(input: {
  readonly box: GestureBox;
  readonly screen: { readonly width: number; readonly height: number };
  readonly start: { readonly clientX: number; readonly clientY: number };
  readonly end: { readonly clientX: number; readonly clientY: number };
  readonly heldMs: number;
}): RevylInput {
  const point = devicePoint(input.box, input.screen, input.start.clientX, input.start.clientY);
  const dx = input.end.clientX - input.start.clientX;
  const dy = input.end.clientY - input.start.clientY;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
    return input.heldMs >= LONG_PRESS_MS
      ? { _tag: "longPress", ...point }
      : { _tag: "tap", ...point };
  }
  const direction =
    Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  return { _tag: "swipe", ...point, direction };
}
