/**
 * `KeyboardInputSource` — impure edge adapter implementing the `InputSource`
 * port.
 *
 * Maps keyboard input to the domain: arrow keys and WASD become directional
 * `MoveCommand`s (R2.1), and activating the new-session control (a button click,
 * or Enter/Space while it is focused) triggers the new-session handler (R5.4,
 * R6.1). Movement input is represented as data (Command pattern), decoupling the
 * source of input from its processing.
 *
 * Living at the edge, it is one of the few places allowed to touch the DOM and
 * `KeyboardEvent`, keeping the core and application layers free of direct input
 * access (Dependency Inversion). Tests substitute a fake `InputSource` in its
 * place. Single Responsibility: translate raw input events into domain
 * commands/notifications and nothing else.
 *
 * It validates its DOM handles at construction and fails fast with a clear
 * error, since a missing key target or control is unrecoverable in the
 * composition root.
 *
 * _Requirements: 2.1, 5.4, 6.1_
 */
import type { Direction } from "../core";
import type { InputSource, MoveCommand } from "./ports";

/**
 * Minimal shape of an event target that supports add/remove listeners. Accepts
 * `window`, `document`, or any `EventTarget` (e.g. a focusable element) without
 * pinning to a concrete DOM class.
 */
type KeyEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Maps keyboard keys (arrows and WASD) to movement directions. */
const KEY_TO_DIRECTION: Readonly<Record<string, Direction>> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  w: "Up",
  s: "Down",
  a: "Left",
  d: "Right",
  W: "Up",
  S: "Down",
  A: "Left",
  D: "Right",
};

/** Arrow keys whose default scrolling behavior is suppressed during play. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/** Keys that activate the focused new-session control (in addition to click). */
const ACTIVATION_KEYS: ReadonlySet<string> = new Set([" ", "Enter"]);

const KEYDOWN = "keydown";
const CLICK = "click";

export class KeyboardInputSource implements InputSource {
  private commandHandler: ((command: MoveCommand) => void) | null = null;
  private newSessionHandler: (() => void) | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.handleMovementKey(event);
  };

  private readonly onControlKeyDown = (event: KeyboardEvent): void => {
    if (ACTIVATION_KEYS.has(event.key)) {
      event.preventDefault();
      this.emitNewSession();
    }
  };

  private readonly onControlClick = (): void => {
    this.emitNewSession();
  };

  /**
   * @param keyTarget    Event target that receives keydown events for movement
   *                     (typically `window` or `document`).
   * @param newSessionControl Element whose activation starts a new session
   *                     (typically a button).
   */
  constructor(
    private readonly keyTarget: KeyEventTarget,
    private readonly newSessionControl: KeyEventTarget,
  ) {
    this.assertValidTarget(keyTarget, "keyTarget");
    this.assertValidTarget(newSessionControl, "newSessionControl");

    this.keyTarget.addEventListener(KEYDOWN, this.onKeyDown as EventListener);
    this.newSessionControl.addEventListener(CLICK, this.onControlClick);
    this.newSessionControl.addEventListener(
      KEYDOWN,
      this.onControlKeyDown as EventListener,
    );
  }

  onCommand(handler: (command: MoveCommand) => void): void {
    this.commandHandler = handler;
  }

  onNewSession(handler: () => void): void {
    this.newSessionHandler = handler;
  }

  dispose(): void {
    this.keyTarget.removeEventListener(KEYDOWN, this.onKeyDown as EventListener);
    this.newSessionControl.removeEventListener(CLICK, this.onControlClick);
    this.newSessionControl.removeEventListener(
      KEYDOWN,
      this.onControlKeyDown as EventListener,
    );
    this.commandHandler = null;
    this.newSessionHandler = null;
  }

  /** Translate a movement key into a `MoveCommand`; ignore unmapped keys. */
  private handleMovementKey(event: KeyboardEvent): void {
    const direction = KEY_TO_DIRECTION[event.key];
    if (direction === undefined) {
      return;
    }
    if (SCROLL_KEYS.has(event.key)) {
      event.preventDefault();
    }
    this.commandHandler?.({ kind: "move", direction });
  }

  private emitNewSession(): void {
    this.newSessionHandler?.();
  }

  private assertValidTarget(target: KeyEventTarget, name: string): void {
    if (
      target === null ||
      target === undefined ||
      typeof target.addEventListener !== "function" ||
      typeof target.removeEventListener !== "function"
    ) {
      throw new Error(
        `KeyboardInputSource: "${name}" must be a valid event target with add/removeEventListener.`,
      );
    }
  }
}
