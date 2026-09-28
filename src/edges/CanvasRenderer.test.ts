/**
 * Smoke test for `CanvasRenderer`.
 *
 * Confirms construction fails fast without a context and that the core draw
 * methods run against a minimal mock 2D context using only standard
 * `CanvasRenderingContext2D` members. Exhaustive rendering assertions live in
 * task 12.5's unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import { CellKind, type GameResult, type Maze, type Position } from "../core";
import { CanvasRenderer } from "./CanvasRenderer";

/** Typed spies for the standard 2D-context members the adapter may call. */
interface MockCtx {
  ctx: CanvasRenderingContext2D;
  fillRect: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
}

/** Build a mock 2D context recording the standard calls the adapter may use. */
function mockContext(width = 240, height = 240): MockCtx {
  const spies = {
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
  };
  const ctx = {
    canvas: { width, height } as HTMLCanvasElement,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    ...spies,
    save: vi.fn(),
    restore: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, ...spies };
}

const maze: Maze = {
  rows: 2,
  columns: 2,
  grid: [
    [CellKind.Path, CellKind.Wall],
    [CellKind.Path, CellKind.Path],
  ],
  start: { row: 0, column: 0 },
  exit: { row: 1, column: 1 },
};

describe("CanvasRenderer construction", () => {
  it("throws a clear error when no context is provided", () => {
    expect(() => new CanvasRenderer(null)).toThrow(/CanvasRenderingContext2D/);
  });

  it("constructs with a valid context", () => {
    expect(() => new CanvasRenderer(mockContext().ctx)).not.toThrow();
  });
});

describe("CanvasRenderer drawing", () => {
  it("fills a rect per cell and draws the exit marker", () => {
    const { ctx, fillRect, strokeRect } = mockContext();
    new CanvasRenderer(ctx).renderMaze(maze);
    // 4 cells + 1 exit marker.
    expect(fillRect).toHaveBeenCalledTimes(5);
    expect(strokeRect).toHaveBeenCalledTimes(4);
  });

  it("draws the avatar within bounds and skips out-of-bounds positions", () => {
    const { ctx, fillRect } = mockContext();
    const renderer = new CanvasRenderer(ctx);
    renderer.renderAvatar({ row: 0, column: 0 }, maze);
    expect(fillRect).toHaveBeenCalledTimes(1);

    const offGrid: Position = { row: 5, column: 5 };
    renderer.renderAvatar(offGrid, maze);
    expect(fillRect).toHaveBeenCalledTimes(1);
  });

  it("re-renders the avatar at the new cell after a move (R2.4)", () => {
    const { ctx, fillRect } = mockContext();
    const renderer = new CanvasRenderer(ctx);

    // Initial render at the start cell, then a re-render after moving one cell
    // down — the two draws must land at different coordinates.
    const before: Position = { row: 0, column: 0 };
    const after: Position = { row: 1, column: 0 };
    renderer.renderAvatar(before, maze);
    renderer.renderAvatar(after, maze);

    // Two distinct draws, one per rendered position.
    expect(fillRect).toHaveBeenCalledTimes(2);

    // Each draw is a fillRect(x, y, w, h); the y differs because only the row
    // changed, proving the avatar was redrawn at the new cell rather than the old.
    const firstY = fillRect.mock.calls[0]?.[1] as number;
    const secondY = fillRect.mock.calls[1]?.[1] as number;
    expect(secondY).toBeGreaterThan(firstY);
  });

  it("renders remaining time as whole seconds", () => {
    const { ctx, fillText } = mockContext();
    new CanvasRenderer(ctx).renderRemainingTime(12.7);
    expect(fillText).toHaveBeenCalledWith(
      expect.stringContaining("12"),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("renders distinct win and loss messages", () => {
    const { ctx, fillText } = mockContext();
    const renderer = new CanvasRenderer(ctx);
    const win: GameResult = { outcome: "Won", elapsedSeconds: 3.21 };
    renderer.renderResult(win);
    renderer.renderResult({ outcome: "Lost", reason: "TimeExpired" });
    const texts = fillText.mock.calls.map((c) => c[0] as string);
    expect(texts.some((t) => /won/i.test(t))).toBe(true);
    expect(texts.some((t) => /lost/i.test(t))).toBe(true);
  });

  it("clears the result area", () => {
    const { ctx, clearRect } = mockContext();
    new CanvasRenderer(ctx).clearResult();
    expect(clearRect).toHaveBeenCalledTimes(1);
  });

  it("renders an invalid-maze indication", () => {
    const { ctx, fillText } = mockContext();
    new CanvasRenderer(ctx).renderInvalidMaze("NoExit");
    expect(fillText).toHaveBeenCalledWith(
      expect.stringMatching(/invalid maze/i),
      expect.any(Number),
      expect.any(Number),
    );
  });
});
