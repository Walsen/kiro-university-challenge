/**
 * `CanvasRenderer` — impure edge adapter implementing the `Renderer` port
 * against a `CanvasRenderingContext2D`.
 *
 * It is a pure projection of immutable game state onto pixels: it contains no
 * game rules. All decisions about *what* the state is live in the core; this
 * adapter only decides *how* to draw a maze, avatar, exit marker, remaining
 * time, and result/invalid-maze messages. Per the architecture steering, this
 * is one of the only modules allowed to touch the browser.
 *
 * The rendering context is injected (Dependency Injection) and validated at
 * construction so a missing/invalid canvas fails fast with a clear error rather
 * than surfacing as a confusing runtime failure mid-game.
 */
import {
  CellKind,
  type GameResult,
  type Maze,
  type MazeValidationError,
  type Position,
} from "../core";
import type { Renderer } from "./ports";

// ---------------------------------------------------------------------------
// Layout / style constants (no magic numbers or strings scattered in methods)
// ---------------------------------------------------------------------------

/** Side length, in pixels, of a single maze cell. */
const CELL_SIZE_PX = 24;
/** Width, in pixels, of the grid line drawn around each cell. */
const GRID_LINE_WIDTH_PX = 1;
/** Fraction of a cell the avatar/exit markers occupy, leaving an inset border. */
const MARKER_INSET_RATIO = 0.2;

const COLOR_PATH = "#f5f5f5";
const COLOR_WALL = "#2b2b2b";
const COLOR_GRID_LINE = "#cccccc";
const COLOR_AVATAR = "#1e88e5";
const COLOR_EXIT = "#43a047";
const COLOR_TIME_TEXT = "#212121";
const COLOR_RESULT_WIN = "#2e7d32";
const COLOR_RESULT_LOSS = "#c62828";
const COLOR_INVALID = "#c62828";

/** Font size, in pixels, of the remaining-time line (bold for legibility). */
const TIME_LABEL_FONT_SIZE_PX = 18;
/** Baseline offset of the result text within the result area. */
const RESULT_TEXT_OFFSET_PX = 28;

const FONT_TIME = `bold ${TIME_LABEL_FONT_SIZE_PX}px sans-serif`;
const FONT_RESULT = "bold 24px sans-serif";
const FONT_INVALID = "16px sans-serif";

/**
 * HUD layout, in pixels, for the band drawn beneath the maze grid. The band is
 * two stacked lines so they never overlap each other or the grid:
 *   [grid] → HUD_MARGIN → time line → result line.
 * Must stay within the canvas's reserved HUD band (see `HUD_BAND_HEIGHT_PX` in
 * `main.ts`, which is sized to `HUD_MARGIN + TIME_LINE_HEIGHT + RESULT_AREA`).
 */
const HUD_MARGIN_PX = 8;
/** Height of the remaining-time line (its own row just below the grid). */
const TIME_LINE_HEIGHT_PX = 24;
/** Height, in pixels, of the band reserved for result / invalid-maze text. */
const RESULT_AREA_HEIGHT_PX = 40;

const TIME_LABEL_PREFIX = "Time: ";
const TIME_LABEL_SUFFIX = "s";
const RESULT_WIN_PREFIX = "You won! ";
const RESULT_WIN_SUFFIX = "s";
const RESULT_LOSS_MESSAGE = "Time's up — you lost.";
const INVALID_MAZE_PREFIX = "Invalid maze: ";

/** Human-readable text for each validation error (R1.6 indication). */
const INVALID_MAZE_MESSAGES: Readonly<Record<MazeValidationError, string>> = {
  NoStart: "no start cell.",
  MultipleStarts: "more than one start cell.",
  NoExit: "no exit cell.",
  MultipleExits: "more than one exit cell.",
  StartEqualsExit: "start and exit are the same cell.",
  NoPathFromStartToExit: "no path from start to exit.",
};

/**
 * Draws immutable game state onto a 2D canvas context.
 *
 * Construct one with a live `CanvasRenderingContext2D`; the constructor throws
 * if the context is missing so the composition root fails fast.
 */
export class CanvasRenderer implements Renderer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D | null | undefined) {
    if (!ctx || typeof ctx.fillRect !== "function") {
      throw new Error(
        "CanvasRenderer requires a valid CanvasRenderingContext2D; received none.",
      );
    }
    this.ctx = ctx;
  }

  /** Draw the maze grid with visually distinct path and wall cells (R1.1). */
  renderMaze(maze: Maze): void {
    for (let row = 0; row < maze.rows; row++) {
      const cells = maze.grid[row];
      if (!cells) continue;
      for (let column = 0; column < maze.columns; column++) {
        const kind = cells[column];
        if (kind === undefined) continue;
        this.drawCell(row, column, kind);
      }
    }
    this.drawExitMarker(maze.exit);
  }

  /** Draw the avatar centered in its cell; used at start and after each move (R1.2, R2.4). */
  renderAvatar(position: Position, maze: Maze): void {
    if (!this.isWithin(position, maze)) return;
    this.drawMarker(position, COLOR_AVATAR);
  }

  /** Draw the remaining time as whole seconds beneath the grid (R3.2). */
  renderRemainingTime(secondsRemaining: number): void {
    const seconds = Math.max(0, Math.floor(secondsRemaining));
    this.withTextStyle(FONT_TIME, COLOR_TIME_TEXT, () => {
      this.ctx.fillText(
        `${TIME_LABEL_PREFIX}${seconds}${TIME_LABEL_SUFFIX}`,
        HUD_MARGIN_PX,
        this.timeTextY(),
      );
    });
  }

  /** Draw a win/loss result message distinguishing the two outcomes (R4.3, R5.1, R5.2). */
  renderResult(result: GameResult): void {
    this.clearResult();
    if (result.outcome === "Won") {
      this.drawResultText(
        `${RESULT_WIN_PREFIX}${result.elapsedSeconds.toFixed(2)}${RESULT_WIN_SUFFIX}`,
        COLOR_RESULT_WIN,
      );
    } else {
      this.drawResultText(RESULT_LOSS_MESSAGE, COLOR_RESULT_LOSS);
    }
  }

  /** Indicate that the maze is invalid and the session did not begin (R1.6). */
  renderInvalidMaze(error: MazeValidationError): void {
    this.clearResult();
    this.withTextStyle(FONT_INVALID, COLOR_INVALID, () => {
      this.ctx.fillText(
        `${INVALID_MAZE_PREFIX}${INVALID_MAZE_MESSAGES[error]}`,
        HUD_MARGIN_PX,
        this.resultTextY(),
      );
    });
  }

  /** Clear the result-message area so a prior outcome no longer shows (R5.5, R6.4). */
  clearResult(): void {
    this.ctx.clearRect(
      0,
      this.resultAreaTop(),
      this.ctx.canvas.width,
      RESULT_AREA_HEIGHT_PX,
    );
  }

  // -------------------------------------------------------------------------
  // Private drawing helpers (each small and single-purpose)
  // -------------------------------------------------------------------------

  private drawCell(row: number, column: number, kind: CellKind): void {
    const x = column * CELL_SIZE_PX;
    const y = row * CELL_SIZE_PX;
    this.ctx.fillStyle = kind === CellKind.Wall ? COLOR_WALL : COLOR_PATH;
    this.ctx.fillRect(x, y, CELL_SIZE_PX, CELL_SIZE_PX);
    this.ctx.strokeStyle = COLOR_GRID_LINE;
    this.ctx.lineWidth = GRID_LINE_WIDTH_PX;
    this.ctx.strokeRect(x, y, CELL_SIZE_PX, CELL_SIZE_PX);
  }

  private drawExitMarker(exit: Position): void {
    this.drawMarker(exit, COLOR_EXIT);
  }

  /** True when a position falls inside the maze grid bounds. */
  private isWithin(position: Position, maze: Maze): boolean {
    return (
      position.row >= 0 &&
      position.row < maze.rows &&
      position.column >= 0 &&
      position.column < maze.columns
    );
  }

  /** Draw an inset filled square inside a cell, distinct from path/wall fill. */
  private drawMarker(position: Position, color: string): void {
    const inset = CELL_SIZE_PX * MARKER_INSET_RATIO;
    const size = CELL_SIZE_PX - inset * 2;
    const x = position.column * CELL_SIZE_PX + inset;
    const y = position.row * CELL_SIZE_PX + inset;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, size, size);
  }

  private drawResultText(text: string, color: string): void {
    this.withTextStyle(FONT_RESULT, color, () => {
      this.ctx.fillText(text, HUD_MARGIN_PX, this.resultTextY());
    });
  }

  /** Apply font/fill for a text draw, restoring prior context state after. */
  private withTextStyle(font: string, color: string, draw: () => void): void {
    this.ctx.save();
    this.ctx.font = font;
    this.ctx.fillStyle = color;
    draw();
    this.ctx.restore();
  }

  /**
   * The y of the top of the HUD band: the full canvas height minus the two
   * stacked HUD lines (time + result). The maze grid occupies everything above
   * this, so HUD text never overlaps the grid.
   */
  private hudTop(): number {
    return this.ctx.canvas.height - TIME_LINE_HEIGHT_PX - RESULT_AREA_HEIGHT_PX;
  }

  /** Baseline for the remaining-time line, on its own row below the grid. */
  private timeTextY(): number {
    return this.hudTop() + HUD_MARGIN_PX + TIME_LABEL_FONT_SIZE_PX;
  }

  /** Top of the result-message area, below the time line. */
  private resultAreaTop(): number {
    return this.hudTop() + TIME_LINE_HEIGHT_PX;
  }

  /** Baseline for the result message, within the result area below the time. */
  private resultTextY(): number {
    return this.resultAreaTop() + RESULT_TEXT_OFFSET_PX;
  }
}
