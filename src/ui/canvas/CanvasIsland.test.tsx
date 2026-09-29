/**
 * Smoke test for the Canvas island (task 10.2).
 *
 * Verifies the island embeds the unchanged Phase 1 core: rendering the component
 * mounts `bootstrap`, which wires the real store/controller and hands the wired
 * game to `onWiredGame` in a fresh `Playing` session — proving the seam task
 * 10.3 plugs into exists. jsdom has no 2D context, so we stub
 * `HTMLCanvasElement.prototype.getContext` (the only genuinely-external browser
 * primitive), exactly as the composition-root smoke test does; `bootstrap`'s own
 * rAF loop is not scheduled because we do not need frames for the wiring check.
 */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WiredGame } from "../../main";
import { CanvasIsland } from "./CanvasIsland";

/** Minimal mock 2D context: settable style props plus no-op draw spies. */
function mockContext(): CanvasRenderingContext2D {
  return {
    canvas: { width: 504, height: 552 } as HTMLCanvasElement,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe("CanvasIsland", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts the unchanged Phase 1 core and hands back a Playing wired game", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(mockContext());

    let wired: WiredGame | undefined;
    render(<CanvasIsland onWiredGame={(game) => (wired = game)} />);

    expect(wired).toBeDefined();
    if (wired === undefined) {
      throw new Error("CanvasIsland did not wire the game");
    }
    // A fresh session started through the real store/controller (the 10.3 seam).
    expect(wired.store.getState().status).toBe("Playing");
  });
});
