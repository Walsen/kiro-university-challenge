/**
 * `CanvasIsland` — the React component that embeds the unchanged Phase 1 maze
 * core as a "Canvas island" inside the SPA shell (task 10.2).
 *
 * ## Why an island, and why it embeds `bootstrap` unchanged
 *
 * The Phase 1 game (pure `core` + `app` `GameStore`/`GameController` + the
 * `CanvasRenderer`/`KeyboardInputSource`/`SystemClock` edges) already renders a
 * fluid maze driven by its own `requestAnimationFrame` loop in the composition
 * root (`src/main.ts` `bootstrap`). The design keeps that as a **Canvas island**
 * so gameplay stays fluid (R12.2) while the surrounding chrome is React: the
 * React tree must **not** drive per-frame rendering. So this component does not
 * reimplement any maze rendering or rules — it renders the two DOM elements the
 * composition root's DOM contract expects (`<canvas id="maze">` and
 * `<button id="new-session">`), then calls `bootstrap` once on mount against a
 * root scoped to this subtree. The rAF loop lives entirely inside `bootstrap`;
 * React only mounts and unmounts the island.
 *
 * `src/core` and `src/main.ts` are reused **unchanged** — nothing here imports a
 * core rule or a browser edge directly beyond the composition root's public
 * `bootstrap`/`WiredGame` surface.
 *
 * ## The seam for task 10.3 (do not wire submission here)
 *
 * Task 10.3 wires "on a local win, submit the run". This component exposes that
 * seam without implementing it: once wired, it invokes the optional
 * {@link CanvasIslandProps.onWiredGame} callback with the live {@link WiredGame}
 * so a future effect can `store.subscribe(...)` and react to a `Won` state. This
 * task leaves that callback unused by the shell.
 */
import { useEffect, useRef } from "react";

import {
  bootstrap,
  CANVAS_ELEMENT_ID,
  NEW_SESSION_ELEMENT_ID,
  type CapturedRun,
  type RunMazeParams,
  type WiredGame,
} from "../../main";

export interface CanvasIslandProps {
  /**
   * The scope to play (size + seed + time limit). When provided, `bootstrap`
   * generates the maze from `mazeParams.seed` with the seeded generator — the
   * same maze the server rebuilds when validating a submission (task 10.3). When
   * absent, the island plays a standalone `Math.random` maze (task 10.2 shell).
   */
  readonly mazeParams?: RunMazeParams;
  /**
   * Invoked once when the current run is won locally, with the captured
   * `(seed, moves, clientElapsedMs)`. Task 10.3 uses this to submit the run;
   * never fired on a loss.
   */
  readonly onRun?: (run: CapturedRun) => void;
  /**
   * Optional hook handed the wired game once `bootstrap` has run, so a caller
   * can observe the store directly. Unused by the shell in task 10.2.
   */
  readonly onWiredGame?: (game: WiredGame) => void;
}

/**
 * A minimal `getElementById` root scoped to a container element, so `bootstrap`
 * finds *this island's* canvas and control rather than reaching the whole
 * document. `bootstrap` only needs `getElementById`; scoping it keeps multiple
 * islands (or the shell's other DOM) from colliding on the fixed element ids.
 */
function scopedRoot(container: HTMLElement): { getElementById(id: string): Element | null } {
  return {
    getElementById(id: string): Element | null {
      return container.querySelector(`#${id}`);
    },
  };
}

export function CanvasIsland({
  mazeParams,
  onRun,
  onWiredGame,
}: CanvasIslandProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep the latest callbacks/scope in refs so the mount effect can stay
  // one-shot (deps `[]`) without capturing stale values or re-bootstrapping when
  // the parent re-renders with a new function identity. `bootstrap` reads these
  // once on mount; the run/scope for the island's lifetime is fixed at mount.
  const onWiredGameRef = useRef(onWiredGame);
  onWiredGameRef.current = onWiredGame;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const mazeParamsRef = useRef(mazeParams);
  mazeParamsRef.current = mazeParams;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    // Wire and start the Phase 1 game against this subtree and the real window
    // (its rAF loop, key events). For a platform Run the scope seeds the maze
    // and the won run is reported through `onRun`. This is the single place the
    // island touches the composition root.
    const scope = mazeParamsRef.current;
    const game = bootstrap(scopedRoot(container), window, {
      ...(scope ? { mazeParams: scope } : {}),
      onRun: (run) => onRunRef.current?.(run),
      // Keyboard listens on this focusable island element, not `window`, so
      // arrow/WASD keys reach the game regardless of which element in the
      // surrounding SPA holds focus. The rAF loop still uses `window`.
      keyTarget: container,
    });
    onWiredGameRef.current?.(game);
    // Give the island focus so the player can move immediately without first
    // clicking the maze; the container is focusable via tabIndex below.
    container.focus();
    // `bootstrap` owns the rAF loop; there is no React-side cleanup to run for
    // it here (the whole subtree is torn down on unmount).
  }, []);

  return (
    <div
      className="canvas-island"
      ref={containerRef}
      // Focusable so it can receive keyboard input (arrow/WASD). Auto-focused on
      // mount; the keydown listener is attached to this element by `bootstrap`
      // via `keyTarget`, so movement works without the player clicking first.
      tabIndex={0}
      role="application"
      aria-label="Maze game board. Use the arrow keys or W, A, S, D to move."
    >
      <canvas
        id={CANVAS_ELEMENT_ID}
        className="canvas-island__canvas"
        role="img"
        aria-label="Maze game board"
      />
      <button
        id={NEW_SESSION_ELEMENT_ID}
        type="button"
        className="btn btn--primary"
        aria-label="Start a new game"
      >
        New Game
      </button>
    </div>
  );
}
