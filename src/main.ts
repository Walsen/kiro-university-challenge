/**
 * Composition root.
 *
 * The single place where concrete edge adapters (`SystemClock`,
 * `CanvasRenderer`, `KeyboardInputSource`, `RecursiveBacktrackerGenerator`) are
 * constructed and injected into the pure core and application layers. No other
 * module constructs its own collaborators, and — besides the edge adapters
 * themselves — this is the only module allowed to touch the DOM, `window`, and
 * `requestAnimationFrame`. See `.kiro/steering/architecture.md`.
 *
 * Responsibilities (Task 14.1):
 * 1. Read the DOM: locate the `<canvas>` and its 2D context and the new-session
 *    control, failing fast with a clear error if any are missing (design "Error
 *    Handling").
 * 2. Parse the optional player-specified time limit (a `?time=` query param)
 *    through the pure `parseTimeLimit`, falling back to the default on
 *    invalid/absent input (R7.2, R7.3).
 * 3. Construct `rng` (`Math.random` is acceptable here in the impure edge — the
 *    core never reaches it), the generator, maze factory, clock, renderer, and
 *    keyboard input, then build the initial state and wire the `GameStore` and
 *    `GameController` (Dependency Injection).
 * 4. Start the controller, dispatch the initial `StartSession`, and drive the
 *    real animation loop with `requestAnimationFrame`, the frame scheduling that
 *    lives only in the composition root (R1.1, R3.1, R5.4, R6.1).
 *
 * The module is import-safe: it exports `bootstrap(...)` and only auto-runs when
 * loaded as the page entry point (a real `window`/`document` with the expected
 * canvas element present), so importing it in a test (Task 14.2) does not
 * trigger DOM work.
 */
import {
  DefaultMazeFactory,
  RecursiveBacktrackerGenerator,
  parseTimeLimit,
  type Direction,
  type GameConfig,
  type GameState,
  type MazeResult,
  type TimeLimit,
} from "./core";
import {
  CanvasRenderer,
  KeyboardInputSource,
  SystemClock,
  mulberry32,
  type InputSource,
  type MoveCommand,
} from "./edges";
import { GameController, GameStore, type MazeSource } from "./app";

// ---------------------------------------------------------------------------
// Layout constants (no magic numbers). A cell is 24px in the CanvasRenderer, so
// the canvas is sized to the grid plus the HUD/result band beneath it.
// ---------------------------------------------------------------------------

/** Maze grid dimensions. Odd values give a true bottom-right exit corner. */
const MAZE_ROWS = 21;
const MAZE_COLUMNS = 21;

/** Must match `CELL_SIZE_PX` in `CanvasRenderer`. */
const CELL_SIZE_PX = 24;
/**
 * Extra vertical space beneath the grid for the two stacked HUD lines (the
 * remaining-time line and the result message), sized to match the renderer's
 * HUD layout (HUD_MARGIN 8 + time line 24 + result area 40) so neither overlaps
 * the grid or the other.
 */
const HUD_BAND_HEIGHT_PX = 72;

/** DOM contract: element ids the `index.html` must provide. */
const CANVAS_ELEMENT_ID = "maze";
const NEW_SESSION_ELEMENT_ID = "new-session";

/** Query-string key carrying an optional player-specified time limit. */
const TIME_LIMIT_QUERY_PARAM = "time";

/**
 * The DOM handles the composition root needs. Kept minimal so a test can pass a
 * jsdom document (Task 14.2) without a full browser. `getElementById` is typed
 * to return `Element | null` (not `HTMLElement`) so a jsdom document from a
 * different realm satisfies it structurally.
 */
interface BootstrapRoot {
  getElementById(id: string): Element | null;
}

/**
 * Structural shape of a canvas element: enough to obtain a 2D context and be
 * sized. Validated by duck-typing rather than `instanceof HTMLCanvasElement`,
 * because a jsdom canvas created in a test realm is not an instance of the
 * ambient global constructor (cross-realm `instanceof` fails).
 */
interface CanvasLike {
  getContext(contextId: "2d"): CanvasRenderingContext2D | null;
  width: number;
  height: number;
}

/** Optional window-like source for the loop, input target, and query string. */
interface BootstrapEnv {
  requestAnimationFrame?: (callback: () => void) => void;
  location?: { readonly search?: string };
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
}

/**
 * The wired application, returned so a caller (or test) can inspect or drive it
 * without reaching back into module internals.
 */
export interface WiredGame {
  readonly store: GameStore;
  readonly controller: GameController;
  readonly config: GameConfig;
}

/**
 * The maze parameters that scope a Run (task 10.3). Structurally the platform's
 * `MazeParams` (size + generation `seed` + time limit); kept as a local shape so
 * the composition root does not import the platform port (dependencies point
 * inward). When supplied, `bootstrap` builds the maze from these — the same
 * seed and generator the server replays with — so a local win produces a
 * submission the server accepts.
 */
export interface RunMazeParams {
  readonly rows: number;
  readonly columns: number;
  readonly seed: number;
  readonly timeLimitSeconds: number;
}

/**
 * A completed local win, captured for score submission (task 10.3, R4.1). The
 * `seed` and `moves` are exactly what the server needs to rebuild the maze and
 * replay the run; `clientElapsedMs` is advisory (the server recomputes an
 * authoritative time, R4.6).
 */
export interface CapturedRun {
  readonly seed: number;
  readonly moves: ReadonlyArray<Direction>;
  readonly clientElapsedMs: number;
}

/**
 * Optional wiring for a platform Run (task 10.3). Absent for the standalone
 * Phase 1 browser auto-run, which keeps generating a `Math.random` maze from the
 * fixed dimensions.
 */
export interface BootstrapOptions {
  /**
   * The scope to play. When present, the maze is generated from
   * `params.seed` with the seeded generator (matching the server's replay) and
   * sized/timed from `params` rather than the fixed defaults.
   */
  readonly mazeParams?: RunMazeParams;
  /**
   * Invoked once when the session is won locally, with the captured
   * `(seed, moves, clientElapsedMs)` for submission. Never called for a loss.
   */
  readonly onRun?: (run: CapturedRun) => void;
  /**
   * The event target the keyboard input listens on. Defaults to `env` (the
   * `window`), which is correct for the standalone page where the document has
   * focus. When the game is embedded in a larger app (the React SPA's Canvas
   * island), the host passes a **focusable element** here (and focuses it) so
   * arrow/WASD keydowns are delivered to the game rather than being swallowed by
   * whatever element in the surrounding UI holds focus. Must support
   * add/removeEventListener (an `HTMLElement` or `window`).
   */
  readonly keyTarget?: BootstrapEnv;
}

/**
 * Wire and start the game against the given DOM root and environment.
 *
 * @param root - the document to read canvas/control elements from.
 * @param env - the window-like host providing the animation loop, the key event
 *   target, and the query string. The browser auto-run passes the global
 *   `window`; a test passes its own jsdom window.
 */
export function bootstrap(
  root: BootstrapRoot,
  env: BootstrapEnv,
  options: BootstrapOptions = {},
): WiredGame {
  const canvas = getCanvas(root);
  const context = getContext(canvas);
  const newSessionControl = getNewSessionControl(root);

  sizeCanvas(canvas, options.mazeParams);

  const config = resolveConfig(env, options.mazeParams);

  // Impure edge: randomness enters the pure core only through this injected
  // maze source. For a platform Run it is seeded deterministically from the
  // scope's `seed` — the same seeded algorithm the server replays with — so the
  // maze the player solves is the exact maze the server rebuilds (R4.1, R4.6).
  // Standalone Phase 1 keeps its `Math.random` maze.
  const generator = new RecursiveBacktrackerGenerator();
  const mazeFactory = createMazeSource(generator, options.mazeParams);

  const clock = new SystemClock();
  const renderer = new CanvasRenderer(context);
  // Wrap the input so every issued move direction is captured for submission.
  // The server replays the whole sequence (a blocked move is a deterministic
  // no-op there, exactly as in the local `reduce`), so recording every command
  // reproduces the run faithfully without inspecting acceptance here.
  const capturedMoves: Direction[] = [];
  // Keyboard listens on the host-provided focusable element when embedded (so
  // keys reach the game regardless of surrounding-UI focus), else on `env`
  // (`window`) for the standalone page.
  const keyTarget = options.keyTarget ?? env;
  const input = captureMoves(
    new KeyboardInputSource(keyTarget, newSessionControl),
    capturedMoves,
  );

  const initialState = buildInitialState(mazeFactory, config);

  const store = new GameStore(initialState, mazeFactory);
  const controller = new GameController(store, renderer, input, clock, config);

  // The store re-validates the maze on `StartSession` and emits `InvalidMaze`
  // for a bad one; wire that to the renderer so an invalid maze is shown (R1.6).
  store.subscribe((event) => {
    if (event.type === "InvalidMaze") {
      renderer.renderInvalidMaze(event.error);
    }
  });

  wireRunCapture(store, capturedMoves, options);

  controller.start();
  // `GameController.start()` wires the edges and renders the seeded state but
  // does not itself start a session, so the composition root dispatches the
  // first `StartSession` to begin play and render the initial maze (R1.1, R6.1).
  store.dispatch({ type: "StartSession", config });

  scheduleLoop(env, controller);

  return { store, controller, config };
}

// ---------------------------------------------------------------------------
// Run capture (task 10.3): record the moves and report the won run
// ---------------------------------------------------------------------------

/**
 * Decorate an `InputSource` so each `MoveCommand` it emits appends its direction
 * to `sink` before the real handler runs (Decorator over the port). This is the
 * one place the composition root observes issued moves; the wrapped source's
 * new-session and dispose behaviour is passed straight through. A `StartSession`
 * (new game) clears the sink so each Run captures only its own moves — wired in
 * {@link wireRunCapture}.
 */
function captureMoves(inner: InputSource, sink: Direction[]): InputSource {
  return {
    onCommand(handler: (command: MoveCommand) => void): void {
      inner.onCommand((command) => {
        sink.push(command.direction);
        handler(command);
      });
    },
    onNewSession(handler: () => void): void {
      inner.onNewSession(handler);
    },
    dispose(): void {
      inner.dispose();
    },
  };
}

/**
 * Report a captured Run to `options.onRun` the first time the session is won,
 * and reset the move sink whenever a fresh session starts so a new game does not
 * carry over the previous game's moves. Only a `Won` state is reported (a loss
 * is never submitted, R4.1); it is reported once per win via a latch.
 */
function wireRunCapture(
  store: GameStore,
  capturedMoves: Direction[],
  options: BootstrapOptions,
): void {
  const seed = options.mazeParams?.seed;
  let reported = false;

  store.subscribe((event) => {
    if (event.type !== "StateChanged") {
      return;
    }
    const { state } = event;

    if (state.status === "Playing" && state.avatar === state.maze.start) {
      // A fresh session (avatar seated at the start) resets capture so the next
      // win submits only its own moves.
      capturedMoves.length = 0;
      reported = false;
      return;
    }

    if (state.status !== "Won" || reported || seed === undefined) {
      return;
    }
    reported = true;
    options.onRun?.({
      seed,
      moves: [...capturedMoves],
      clientElapsedMs: state.elapsedMs,
    });
  });
}

// ---------------------------------------------------------------------------
// DOM access (fail fast — a missing canvas/control is unrecoverable here)
// ---------------------------------------------------------------------------

function getCanvas(root: BootstrapRoot): CanvasLike {
  const element = root.getElementById(CANVAS_ELEMENT_ID);
  if (!isCanvasLike(element)) {
    throw new Error(
      `Composition root: no usable <canvas id="${CANVAS_ELEMENT_ID}"> found in the document.`,
    );
  }
  return element;
}

/** Duck-type a canvas element so a cross-realm jsdom canvas is accepted. */
function isCanvasLike(element: Element | null): element is Element & CanvasLike {
  return (
    element !== null && typeof (element as Partial<CanvasLike>).getContext === "function"
  );
}

function getContext(canvas: CanvasLike): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Composition root: canvas 2D context is unavailable; cannot render.");
  }
  return context;
}

function getNewSessionControl(root: BootstrapRoot): Element {
  const element = root.getElementById(NEW_SESSION_ELEMENT_ID);
  if (!element) {
    throw new Error(
      `Composition root: no new-session control with id="${NEW_SESSION_ELEMENT_ID}" found.`,
    );
  }
  return element;
}

/**
 * Size the canvas to the maze grid plus the HUD/result band beneath it. Uses
 * the Run's dimensions when a scope is supplied, else the fixed defaults.
 */
function sizeCanvas(canvas: CanvasLike, mazeParams?: RunMazeParams): void {
  const rows = mazeParams?.rows ?? MAZE_ROWS;
  const columns = mazeParams?.columns ?? MAZE_COLUMNS;
  canvas.width = columns * CELL_SIZE_PX;
  canvas.height = rows * CELL_SIZE_PX + HUD_BAND_HEIGHT_PX;
}

// ---------------------------------------------------------------------------
// Configuration and initial state
// ---------------------------------------------------------------------------

/**
 * Build the `GameConfig` for the session. A platform Run takes its dimensions
 * and time limit from the chosen scope (the time limit is branded through the
 * pure validator, so an out-of-range scope falls back to the default); the
 * standalone Phase 1 run uses the fixed dimensions and the optional `?time=`
 * query param.
 */
function resolveConfig(env: BootstrapEnv, mazeParams?: RunMazeParams): GameConfig {
  if (mazeParams !== undefined) {
    return {
      rows: mazeParams.rows,
      columns: mazeParams.columns,
      timeLimit: parseTimeLimit(mazeParams.timeLimitSeconds).value,
    };
  }
  return {
    rows: MAZE_ROWS,
    columns: MAZE_COLUMNS,
    timeLimit: resolveTimeLimit(env),
  };
}

/**
 * Build the maze source the store generates from. This must reconcile with how
 * the server rebuilds a submitted maze: the server calls a fresh
 * `DefaultMazeFactory(generator, mulberry32(seed)).create(rows, columns)` — one
 * generation from a freshly-seeded rng. The store also calls `create` more than
 * once (once to seed the initial state, again on each `StartSession`), so for a
 * platform Run we hand it a source that **re-seeds `mulberry32(seed)` on every
 * `create`**. Each generation then starts from the same seed and yields the
 * identical maze the server rebuilds (design "Determinism"), closing the gap the
 * old single shared `Math.random` rng left open.
 *
 * Standalone Phase 1 keeps a single `Math.random` rng: successive generations
 * differ (a fresh maze per new game), which is the intended local behaviour.
 */
function createMazeSource(
  generator: RecursiveBacktrackerGenerator,
  mazeParams?: RunMazeParams,
): MazeSource {
  if (mazeParams !== undefined) {
    const { seed } = mazeParams;
    return {
      create: (rows, columns): MazeResult =>
        new DefaultMazeFactory(generator, mulberry32(seed)).create(rows, columns),
    };
  }
  // `Math.random` is only ever reached here in the impure composition root.
  const rng = (): number => Math.random();
  return new DefaultMazeFactory(generator, rng);
}

/**
 * Parse the optional `?time=` query param through the pure validator, falling
 * back to the default limit when it is absent or invalid (R7.2, R7.3).
 */
function resolveTimeLimit(env: BootstrapEnv): TimeLimit {
  const raw = readTimeLimitParam(env);
  const parsed = parseTimeLimit(raw);
  return parsed.value;
}

/**
 * Read the raw `time` query value as a number when present. Returns `undefined`
 * when absent so `parseTimeLimit` applies the 60s default (R7.2); a present but
 * non-integer value is passed through as-is so it is rejected (R7.3).
 */
function readTimeLimitParam(env: BootstrapEnv): unknown {
  const search = env.location?.search;
  if (search === undefined || search === "") {
    return undefined;
  }
  const value = new URLSearchParams(search).get(TIME_LIMIT_QUERY_PARAM);
  if (value === null) {
    return undefined;
  }
  return Number(value);
}

/**
 * Build the initial `GameState` carrying a first valid maze. The store re-runs
 * the factory on `StartSession` and seeds its own maze, but it needs a valid
 * state (with a maze whose `start`/`exit` it can reference) to begin from, so
 * we seed an `Idle` state on a freshly generated maze. A generation failure
 * here is a programming error (the generator guarantees validity), so we fail
 * fast rather than model it as recoverable.
 */
function buildInitialState(
  mazeFactory: MazeSource,
  config: GameConfig,
): GameState {
  const result: MazeResult = mazeFactory.create(config.rows, config.columns);
  if (!result.ok) {
    throw new Error(
      `Composition root: initial maze generation produced an invalid maze (${result.error}).`,
    );
  }
  return {
    status: "Idle",
    maze: result.maze,
    avatar: result.maze.start,
    timeLimit: config.timeLimit,
  };
}

// ---------------------------------------------------------------------------
// Animation loop (real frame scheduling lives only in the composition root)
// ---------------------------------------------------------------------------

/**
 * Drive `controller.step()` once per animation frame. If the host provides no
 * `requestAnimationFrame` (e.g. a bare jsdom in a test), the loop is simply not
 * scheduled — the app is still fully wired and has rendered its initial state.
 */
function scheduleLoop(env: BootstrapEnv, controller: GameController): void {
  const raf = env.requestAnimationFrame?.bind(env);
  if (!raf) {
    return;
  }
  const frame = (): void => {
    controller.step();
    raf(frame);
  };
  raf(frame);
}

// ---------------------------------------------------------------------------
// Auto-run only when loaded as the page entry point. Guarded so importing this
// module in a test (Task 14.2) does not touch the DOM: the auto-run fires only
// when a real `window`/`document` is present AND the expected canvas element is
// in the document, which a test harness importing the module for `bootstrap`
// does not provide ambiently. The smoke test calls `bootstrap` itself with its
// own jsdom document.
// ---------------------------------------------------------------------------

function isBrowserEntryPoint(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    document.getElementById(CANVAS_ELEMENT_ID) !== null
  );
}

if (isBrowserEntryPoint()) {
  bootstrap(document, window);
}

export {
  MAZE_ROWS,
  MAZE_COLUMNS,
  CANVAS_ELEMENT_ID,
  NEW_SESSION_ELEMENT_ID,
  TIME_LIMIT_QUERY_PARAM,
};
