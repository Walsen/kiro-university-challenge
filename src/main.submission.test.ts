/**
 * Client-win → server-validation consistency (task 10.3, the crux gate).
 *
 * Task 10.3 wires a local win to a platform score submission. The submission is
 * only useful if the server accepts it: the server rebuilds the maze from the
 * submitted `mazeParams` (rows, columns, **seed**, timeLimitSeconds) with its
 * seeded generator and **replays the submitted `moves`** through the same shared
 * core (`src/core/validateSubmission.ts`). So the client must (a) play the maze
 * built from that seed with the same seeded generator, and (b) capture the exact
 * move sequence.
 *
 * This test proves both ends line up end-to-end, deterministically and without a
 * network:
 *
 *   1. Bootstrap the real composition root with a fixed scope (a `seed`), which
 *      generates the maze with the seeded `mulberry32` rng — the same algorithm
 *      the server replays with.
 *   2. Compute a winning path over that *same* seeded maze and drive it as real
 *      keydown events through the real `KeyboardInputSource` — the actual capture
 *      seam, not a shortcut — until the wired store reaches `Won`.
 *   3. Assert `bootstrap`'s `onRun` fired with the captured `(seed, moves)`.
 *   4. Feed that captured run, verbatim, into `validateSubmission` — the exact
 *      pure path the server uses — and assert it returns an authoritative `Won`
 *      `Score`.
 *
 * If the client generated its maze differently (e.g. the old `Math.random`
 * bootstrap) or captured the wrong moves, step 4 would reject with `not-a-win`.
 * Green here guarantees the client will not submit runs the server rejects.
 *
 * The maze is small and the time limit generous so the winning path's move count
 * stays well inside the server's per-move time budget (`MOVE_DURATION_MS`).
 *
 * _Requirements: R4.1 (submit the move sequence + seed), R4.6 (server-authoritative
 * time); design "Score submission and validation" / "Determinism"._
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CellKind,
  DefaultMazeFactory,
  RecursiveBacktrackerGenerator,
  type Direction,
  type Maze,
  type Position,
} from "./core";
import { mulberry32 } from "./edges";
import { validateSubmission, type MazeParams } from "./core/validateSubmission";
import {
  bootstrap,
  CANVAS_ELEMENT_ID,
  NEW_SESSION_ELEMENT_ID,
  type CapturedRun,
  type WiredGame,
} from "./main";

// A small maze with plenty of time so a shortest-path win stays inside the
// server's per-move budget. Odd dimensions give a true bottom-right exit.
const SCOPE: MazeParams = {
  rows: 11,
  columns: 11,
  seed: 12_345,
  timeLimitSeconds: 60,
};

/** Rebuild the maze the seeded bootstrap plays — identical to the server's. */
function seededMaze(scope: MazeParams): Maze {
  const factory = new DefaultMazeFactory(
    new RecursiveBacktrackerGenerator(),
    mulberry32(scope.seed),
  );
  const result = factory.create(scope.rows, scope.columns);
  if (!result.ok) {
    throw new Error(`test maze scope did not generate a valid maze: ${result.error}`);
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

/** BFS shortest path from start to exit, returned as a list of directions. */
function solve(maze: Maze): Direction[] {
  const key = (p: Position): string => `${p.row},${p.column}`;
  const start = maze.start;
  const queue: Position[] = [start];
  const cameFrom = new Map<string, { prev: Position; dir: Direction }>();
  const seen = new Set<string>([key(start)]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.row === maze.exit.row && current.column === maze.exit.column) {
      return reconstruct(cameFrom, current, key);
    }
    for (const dir of Object.keys(DELTAS) as Direction[]) {
      const delta = DELTAS[dir];
      const next: Position = {
        row: current.row + delta.row,
        column: current.column + delta.column,
      };
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
  throw new Error("no path from start to exit in the seeded maze");
}

function reconstruct(
  cameFrom: Map<string, { prev: Position; dir: Direction }>,
  exit: Position,
  key: (p: Position) => string,
): Direction[] {
  const directions: Direction[] = [];
  let cursor = exit;
  for (;;) {
    const edge = cameFrom.get(key(cursor));
    if (edge === undefined) {
      break;
    }
    directions.unshift(edge.dir);
    cursor = edge.prev;
  }
  return directions;
}

/** Minimal mock 2D context so the real CanvasRenderer runs under bare jsdom. */
function mockContext(): CanvasRenderingContext2D {
  return {
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
  } as unknown as CanvasRenderingContext2D;
}

function buildDom(): void {
  const canvas = document.createElement("canvas");
  canvas.id = CANVAS_ELEMENT_ID;
  const button = document.createElement("button");
  button.id = NEW_SESSION_ELEMENT_ID;
  document.body.append(canvas, button);
  vi.spyOn(canvas, "getContext").mockReturnValue(mockContext());
}

/** A `BootstrapEnv` whose key target is the window; no rAF (deterministic). */
function buildEnv(): Parameters<typeof bootstrap>[1] {
  return {
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    location: { search: "" },
  };
}

/** Dispatch a real keydown to the window — the KeyboardInputSource's target. */
function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key }));
}

describe("client win → server validation consistency (task 10.3)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("captures a seed+moves a local win, that validateSubmission accepts as Won", () => {
    buildDom();

    const captured: CapturedRun[] = [];
    const wired: WiredGame = bootstrap(document, buildEnv(), {
      mazeParams: SCOPE,
      onRun: (run) => captured.push(run),
    });

    // Solve the maze the *seeded* bootstrap built and drive the win as real key
    // events through the real input source (the actual capture seam).
    const path = solve(seededMaze(SCOPE));
    for (const direction of path) {
      pressKey(KEY_FOR[direction]);
    }

    // The local session is won and the run was reported exactly once.
    expect(wired.store.getState().status).toBe("Won");
    expect(captured).toHaveLength(1);
    const run = captured[0]!;
    expect(run.seed).toBe(SCOPE.seed);
    expect(run.moves).toEqual(path);

    // The crux: feed the captured run through the SAME pure path the server
    // uses. It must validate as an authoritative Won score.
    const result = validateSubmission({
      mazeParams: SCOPE,
      moves: run.moves,
      clientElapsedMs: run.clientElapsedMs,
      idempotencyKey: "test-key",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected a valid Won submission, got ${result.reason}`);
    }
    expect(result.score.outcome).toBe("Won");
    expect(result.score.mazeParams).toEqual(SCOPE);
  });
});
