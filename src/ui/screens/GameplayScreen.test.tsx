/**
 * Wiring tests for the Run screen's win → submit → reflect path (task 10.3,
 * R4.1, R5.2, R6.3, R12.5).
 *
 * These render the real {@link GameplayScreen}, which embeds the real Canvas
 * island and the real Phase 1 core seeded from the Run scope. We drive an actual
 * win by dispatching the winning key sequence (computed over the same seeded
 * maze) through the real input source, then assert the screen:
 *   - submits the captured move sequence + scope through the injected fake
 *     {@link PlatformClient} (R4.1);
 *   - reflects the server's authoritative result, including a personal best
 *     (R5.2), and the updated own-rank (R6.3);
 *   - surfaces a typed SDK failure as an explicit, retryable state (R12.5).
 *
 * The fake stands in for the SDK, so nothing touches the network; the maze is
 * seeded, so the run is deterministic. jsdom has no 2D context, so the only
 * genuinely-external browser primitive (`getContext`) is stubbed, exactly as the
 * island's own smoke test does.
 */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CellKind,
  DefaultMazeFactory,
  RecursiveBacktrackerGenerator,
  type Direction,
  type Maze,
  type Position,
} from "../../core";
import { mulberry32 } from "../../edges";
import type {
  MazeParams,
  PlatformResult,
  ScoreSubmission,
  ScoreSubmissionResult,
} from "../../client/ports/PlatformClient";
import { GameplayScreen } from "./GameplayScreen";
import { createFakePlatform } from "../test/fakePlatform";
import { renderWithPlatform } from "../test/renderWithPlatform";

const SCOPE: MazeParams = {
  rows: 11,
  columns: 11,
  seed: 4242,
  timeLimitSeconds: 60,
};

// ---------------------------------------------------------------------------
// Seeded-maze solver (mirrors the composition root's seeded generation)
// ---------------------------------------------------------------------------

function seededMaze(scope: MazeParams): Maze {
  const factory = new DefaultMazeFactory(
    new RecursiveBacktrackerGenerator(),
    mulberry32(scope.seed),
  );
  const result = factory.create(scope.rows, scope.columns);
  if (!result.ok) {
    throw new Error(`seed did not generate a valid maze: ${result.error}`);
  }
  return result.maze;
}

const DELTAS: Readonly<Record<Direction, Position>> = {
  Up: { row: -1, column: 0 },
  Down: { row: 1, column: 0 },
  Left: { row: 0, column: -1 },
  Right: { row: 0, column: 1 },
};

const KEY_FOR: Readonly<Record<Direction, string>> = {
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};

function solve(maze: Maze): Direction[] {
  const key = (p: Position): string => `${p.row},${p.column}`;
  const queue: Position[] = [maze.start];
  const cameFrom = new Map<string, { prev: Position; dir: Direction }>();
  const seen = new Set<string>([key(maze.start)]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.row === maze.exit.row && current.column === maze.exit.column) {
      const dirs: Direction[] = [];
      let cursor = current;
      for (;;) {
        const edge = cameFrom.get(key(cursor));
        if (edge === undefined) break;
        dirs.unshift(edge.dir);
        cursor = edge.prev;
      }
      return dirs;
    }
    for (const dir of Object.keys(DELTAS) as Direction[]) {
      const d = DELTAS[dir];
      const next: Position = { row: current.row + d.row, column: current.column + d.column };
      if (
        next.row < 0 ||
        next.row >= maze.rows ||
        next.column < 0 ||
        next.column >= maze.columns ||
        maze.grid[next.row]?.[next.column] !== CellKind.Path ||
        seen.has(key(next))
      ) {
        continue;
      }
      seen.add(key(next));
      cameFrom.set(key(next), { prev: current, dir });
      queue.push(next);
    }
  }
  throw new Error("no path from start to exit");
}

/**
 * Play the winning sequence as real keydown events on the window. The final
 * winning key triggers the island's `onRun` → the screen's submit, which is a
 * React state update, so the dispatch is wrapped in `act` to flush it.
 */
function playToWin(scope: MazeParams): Direction[] {
  const path = solve(seededMaze(scope));
  act(() => {
    for (const dir of path) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: KEY_FOR[dir] }));
    }
  });
  return path;
}

/** Stub the 2D context so the real CanvasRenderer runs under bare jsdom. */
function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    canvas: { width: 264, height: 312 } as HTMLCanvasElement,
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
  } as unknown as CanvasRenderingContext2D);
}

describe("GameplayScreen — win → submit → reflect (task 10.3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits the captured moves + scope on a local win (R4.1)", async () => {
    stubCanvas();
    const submissions: ScoreSubmission[] = [];
    const client = createFakePlatform({
      submitScore: (submission) => {
        submissions.push(submission);
        return Promise.resolve({
          ok: true,
          value: { persisted: true, isPersonalBest: false, elapsedMs: 5_000 },
        });
      },
    });

    renderWithPlatform(<GameplayScreen params={SCOPE} onBack={() => {}} />, client);

    const path = playToWin(SCOPE);

    await waitFor(() => expect(submissions).toHaveLength(1));
    const submission = submissions[0]!;
    expect(submission.mazeParams).toEqual(SCOPE);
    expect(submission.moves).toEqual(path);
    expect(submission.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("reflects a personal best and the updated own-rank (R5.2, R6.3)", async () => {
    stubCanvas();
    const client = createFakePlatform({
      submitScore: () =>
        Promise.resolve({
          ok: true,
          value: { persisted: true, isPersonalBest: true, elapsedMs: 4_500 },
        }),
      ownRank: () => Promise.resolve({ ok: true, value: { ranked: true, rank: 2 } }),
    });

    renderWithPlatform(<GameplayScreen params={SCOPE} onBack={() => {}} />, client);

    playToWin(SCOPE);

    expect(await screen.findByText("New personal best!")).toBeInTheDocument();
    expect(screen.getByText("Completed in 4.50s")).toBeInTheDocument();
    expect(
      await screen.findByText("Your rank in this scope: #2"),
    ).toBeInTheDocument();
  });

  it("surfaces a typed submission failure as an explicit, retryable state (R12.5)", async () => {
    stubCanvas();
    const client = createFakePlatform({
      submitScore: (): Promise<PlatformResult<ScoreSubmissionResult>> =>
        Promise.resolve({
          ok: false,
          failure: { kind: "network", message: "offline" },
        }),
    });

    renderWithPlatform(<GameplayScreen params={SCOPE} onBack={() => {}} />, client);

    playToWin(SCOPE);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot reach the server",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
