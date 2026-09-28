/**
 * Integration Point D — Composition-root smoke (Task 14.2, BLOCKING gate).
 *
 * The final integration checkpoint. Integration Points A–C composed the real
 * core, the real store, and the real controller with the edges faked. This test
 * closes the last seam: the *full stack with real edges*. It calls the real
 * `bootstrap` composition root, which constructs the real `SystemClock`, real
 * `CanvasRenderer`, real `KeyboardInputSource`, real `RecursiveBacktracker-
 * Generator` + `DefaultMazeFactory`, real `GameStore`, and real `GameController`,
 * wires them together, starts a session, and renders the initial maze.
 *
 *   bootstrap(root, env)
 *     → getElementById(canvas/control) + 2D context
 *     → parseTimeLimit(?time=)  → real edges  → GameStore + GameController
 *     → controller.start() → dispatch(StartSession) → initial render
 *
 * Only what is genuinely external to the app is faked, matching the design's
 * "fake only the DOM/time/input" rule for integration tests:
 *   - the browser's 2D context, which bare jsdom does not implement, is stubbed
 *     with the same minimal mock `CanvasRenderingContext2D` used in
 *     `CanvasRenderer.test.ts` — so the *real* `CanvasRenderer` class runs, only
 *     the missing browser primitive is faked;
 *   - `requestAnimationFrame` is omitted from `env`, so the composition root
 *     skips scheduling the loop (main.ts guards on its presence). The initial
 *     render still happens synchronously on `start()` + `StartSession`, so the
 *     test is deterministic and needs no real rAF or wall clock.
 *
 * Assertions (design Integration Point D, R1.1): the fully wired app initializes
 * and renders an initial maze without throwing; the returned `WiredGame` is in a
 * fresh `Playing` session with the avatar on the maze start; and the real
 * `CanvasRenderer` drew the maze (the mock context's `fillRect`/`fillText` were
 * called), proving the initial maze was rendered end-to-end.
 *
 * _Requirements: 1.1; design "Integration testing" Point D._
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrap,
  CANVAS_ELEMENT_ID,
  NEW_SESSION_ELEMENT_ID,
  type WiredGame,
} from "./main";

/** Typed spies for the standard 2D-context members the renderer may call. */
interface MockCtx {
  ctx: CanvasRenderingContext2D;
  fillRect: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
}

/**
 * Build a minimal mock 2D context recording the standard calls the real
 * `CanvasRenderer` makes. Mirrors the mock in `CanvasRenderer.test.ts`: settable
 * style props plus no-op spies, so the real renderer runs against it unchanged.
 * jsdom does not implement a 2D context, so this fakes only that missing browser
 * primitive — the renderer class itself is the real edge.
 */
function mockContext(): MockCtx {
  const spies = {
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
  };
  const ctx = {
    // `canvas` back-reference: `main.ts` sizes the real canvas, but the renderer
    // reads its dimensions off the context, so mirror sensible defaults.
    canvas: { width: 504, height: 552 } as HTMLCanvasElement,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    ...spies,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, ...spies };
}

/**
 * Build the DOM the composition root expects — a `<canvas id="maze">` and a
 * `<button id="new-session">` appended to the document body — and override the
 * canvas's `getContext` to hand back the mock 2D context (bare jsdom returns
 * null). Returns the elements and the mock context so the test can inspect the
 * draw calls afterwards.
 */
function buildDom(): { canvas: HTMLCanvasElement; mock: MockCtx } {
  const canvas = document.createElement("canvas");
  canvas.id = CANVAS_ELEMENT_ID;
  const button = document.createElement("button");
  button.id = NEW_SESSION_ELEMENT_ID;
  document.body.append(canvas, button);

  const mock = mockContext();
  // The real CanvasRenderer only needs a 2D context; jsdom's canvas returns null
  // from getContext, so hand back the mock context. This keeps `main.ts`'s
  // duck-typed `typeof getContext === "function"` check satisfied.
  vi.spyOn(canvas, "getContext").mockReturnValue(mock.ctx);

  return { canvas, mock };
}

/**
 * A `BootstrapEnv` for the test. `window`'s add/removeEventListener serve as the
 * real `KeyboardInputSource`'s key target; `location.search` is empty so the
 * time limit falls back to the default; `requestAnimationFrame` is intentionally
 * omitted so the composition root does not schedule the loop.
 */
function buildEnv(search = ""): Parameters<typeof bootstrap>[1] {
  return {
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    location: { search },
    // requestAnimationFrame deliberately omitted — the loop is not scheduled.
  };
}

describe("Integration Point D — composition-root smoke", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("wires the full app and renders an initial maze without throwing (R1.1)", () => {
    const { mock } = buildDom();
    const env = buildEnv();

    let wired: WiredGame | undefined;
    expect(() => {
      wired = bootstrap(document, env);
    }).not.toThrow();

    // The real CanvasRenderer drew the initial maze against the mock context:
    // at least one filled cell rect proves the maze was rendered end-to-end.
    expect(mock.fillRect).toHaveBeenCalled();

    if (wired === undefined) {
      throw new Error("bootstrap returned no WiredGame");
    }

    // A fresh session started: the store holds a Playing state with the avatar
    // on the maze start cell (R6.2/R6.3 via the real session factory).
    const state = wired.store.getState();
    expect(state.status).toBe("Playing");
    if (state.status !== "Playing") {
      throw new Error("expected a Playing state after bootstrap");
    }
    expect(state.avatar).toEqual(state.maze.start);
    expect(state.timerStarted).toBe(false);
  });

  it("renders the remaining time on the initial frame (R1.1 HUD)", () => {
    const { mock } = buildDom();

    bootstrap(document, buildEnv());

    // The controller renders the seeded state on start(), which draws the HUD
    // time text via the real renderer — fillText proves the HUD was drawn.
    expect(mock.fillText).toHaveBeenCalled();
  });

  it("does not schedule an animation loop when the env omits requestAnimationFrame", () => {
    const { mock } = buildDom();

    // With no rAF provided, main.ts skips scheduleLoop; the initial render still
    // happened (fillRect called) and no further frames are driven. This keeps
    // the smoke test deterministic with no reliance on real rAF/time.
    expect(() => bootstrap(document, buildEnv())).not.toThrow();
    expect(mock.fillRect).toHaveBeenCalled();
  });
});
