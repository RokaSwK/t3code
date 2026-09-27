import { describe, expect, it } from "vite-plus/test";

import { revylGesture } from "./revylGestures";

const box = { left: 100, top: 50, width: 220, height: 478 };
const screen = { width: 440, height: 956 };

describe("revylGesture", () => {
  it("maps a click on the picture to device points", () => {
    expect(
      revylGesture({
        box,
        screen,
        start: { clientX: 121, clientY: 92 },
        end: { clientX: 123, clientY: 93 },
        heldMs: 80,
      }),
    ).toEqual({ _tag: "tap", x: 42, y: 84 });
  });

  it("holds become long presses and drags become swipes from where they started", () => {
    const start = { clientX: 210, clientY: 400 };
    expect(revylGesture({ box, screen, start, end: start, heldMs: 700 })._tag).toBe("longPress");
    expect(
      revylGesture({ box, screen, start, end: { clientX: 215, clientY: 250 }, heldMs: 200 }),
    ).toEqual({ _tag: "swipe", x: 220, y: 700, direction: "up" });
    expect(
      revylGesture({ box, screen, start, end: { clientX: 120, clientY: 390 }, heldMs: 200 }),
    ).toMatchObject({ direction: "left" });
  });

  it("keeps points on the screen when the pointer leaves the picture", () => {
    expect(
      revylGesture({
        box,
        screen,
        start: { clientX: 90, clientY: 600 },
        end: { clientX: 90, clientY: 600 },
        heldMs: 0,
      }),
    ).toEqual({ _tag: "tap", x: 0, y: 955 });
  });
});
