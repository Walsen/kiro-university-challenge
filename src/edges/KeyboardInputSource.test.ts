/**
 * Unit tests for `KeyboardInputSource` (edge adapter for the `InputSource` port).
 *
 * Exercises the real adapter against real jsdom event targets, faking only the
 * registered domain handlers (`vi.fn`). Verifies that:
 * - arrow/WASD keydown events produce the correct `MoveCommand`s (R2.1),
 * - unmapped keys produce nothing,
 * - activating the new-session control via click or Enter/Space fires the
 *   new-session handler (R5.4, R6.1),
 * - construction fails fast on invalid targets, and
 * - `dispose()` detaches all listeners.
 *
 * _Requirements: 2.1, 5.4, 6.1_
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Direction } from "../core";
import { KeyboardInputSource } from "./KeyboardInputSource";
import type { MoveCommand } from "./ports";

/** A disposable harness bundling the adapter, its DOM targets, and the spies. */
interface Harness {
  input: KeyboardInputSource;
  keyTarget: HTMLElement;
  control: HTMLButtonElement;
  onCommand: ReturnType<typeof vi.fn>;
  onNewSession: ReturnType<typeof vi.fn>;
}

/** Build a `KeyboardInputSource` wired to real jsdom elements with registered spies. */
function makeHarness(): Harness {
  const keyTarget = document.createElement("div");
  const control = document.createElement("button");
  document.body.append(keyTarget, control);

  const input = new KeyboardInputSource(keyTarget, control);
  const onCommand = vi.fn();
  const onNewSession = vi.fn();
  input.onCommand(onCommand);
  input.onNewSession(onNewSession);

  return { input, keyTarget, control, onCommand, onNewSession };
}

/** Dispatch a `keydown` for `key` on `target`; return whether default was prevented. */
function pressKey(target: EventTarget, key: string): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("KeyboardInputSource", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.input.dispose();
    document.body.innerHTML = "";
  });

  describe("construction", () => {
    it("fails fast when the key target is not a valid event target", () => {
      expect(
        () => new KeyboardInputSource(null as unknown as HTMLElement, harness.control),
      ).toThrow(/keyTarget/);
    });

    it("fails fast when the new-session control is not a valid event target", () => {
      expect(
        () => new KeyboardInputSource(harness.keyTarget, {} as unknown as HTMLElement),
      ).toThrow(/newSessionControl/);
    });
  });

  describe("movement keys produce MoveCommands (R2.1)", () => {
    const arrowCases: ReadonlyArray<[string, Direction]> = [
      ["ArrowUp", "Up"],
      ["ArrowDown", "Down"],
      ["ArrowLeft", "Left"],
      ["ArrowRight", "Right"],
    ];

    it.each(arrowCases)("maps %s to a move %s command", (key, direction) => {
      pressKey(harness.keyTarget, key);

      expect(harness.onCommand).toHaveBeenCalledTimes(1);
      const command: MoveCommand = { kind: "move", direction };
      expect(harness.onCommand).toHaveBeenCalledWith(command);
    });

    const wasdCases: ReadonlyArray<[string, Direction]> = [
      ["w", "Up"],
      ["s", "Down"],
      ["a", "Left"],
      ["d", "Right"],
    ];

    it.each(wasdCases)("maps '%s' to a move %s command", (key, direction) => {
      pressKey(harness.keyTarget, key);

      expect(harness.onCommand).toHaveBeenCalledWith({ kind: "move", direction });
    });

    const wasdUpperCases: ReadonlyArray<[string, Direction]> = [
      ["W", "Up"],
      ["S", "Down"],
      ["A", "Left"],
      ["D", "Right"],
    ];

    it.each(wasdUpperCases)(
      "maps uppercase '%s' to a move %s command",
      (key, direction) => {
        pressKey(harness.keyTarget, key);

        expect(harness.onCommand).toHaveBeenCalledWith({ kind: "move", direction });
      },
    );

    it("prevents default scrolling for arrow keys", () => {
      expect(pressKey(harness.keyTarget, "ArrowUp")).toBe(true);
    });

    it("does not prevent default for WASD keys", () => {
      expect(pressKey(harness.keyTarget, "w")).toBe(false);
    });
  });

  describe("unmapped keys are ignored", () => {
    it.each(["x", "z", "1", "Shift", "Escape"])(
      "does not emit a command for '%s'",
      (key) => {
        pressKey(harness.keyTarget, key);

        expect(harness.onCommand).not.toHaveBeenCalled();
      },
    );

    it("does not treat movement keys on the key target as new-session activation", () => {
      pressKey(harness.keyTarget, "ArrowUp");

      expect(harness.onNewSession).not.toHaveBeenCalled();
    });
  });

  describe("new-session control activation (R5.4, R6.1)", () => {
    it("fires the new-session handler on click", () => {
      harness.control.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(harness.onNewSession).toHaveBeenCalledTimes(1);
    });

    it("fires the new-session handler on Enter", () => {
      expect(pressKey(harness.control, "Enter")).toBe(true);

      expect(harness.onNewSession).toHaveBeenCalledTimes(1);
    });

    it("fires the new-session handler on Space", () => {
      expect(pressKey(harness.control, " ")).toBe(true);

      expect(harness.onNewSession).toHaveBeenCalledTimes(1);
    });

    it("does not fire on other keys pressed on the control", () => {
      pressKey(harness.control, "a");

      expect(harness.onNewSession).not.toHaveBeenCalled();
    });

    it("does not emit a MoveCommand when activating the control", () => {
      harness.control.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(harness.onCommand).not.toHaveBeenCalled();
    });
  });

  describe("handler registration", () => {
    it("routes commands to the most recently registered handler", () => {
      const replacement = vi.fn();
      harness.input.onCommand(replacement);

      pressKey(harness.keyTarget, "ArrowUp");

      expect(replacement).toHaveBeenCalledWith({ kind: "move", direction: "Up" });
      expect(harness.onCommand).not.toHaveBeenCalled();
    });

    it("does not throw when no command handler is registered", () => {
      const bare = new KeyboardInputSource(harness.keyTarget, harness.control);

      expect(() => pressKey(harness.keyTarget, "ArrowUp")).not.toThrow();
      bare.dispose();
    });
  });

  describe("dispose() detaches listeners", () => {
    it("stops emitting movement commands after dispose", () => {
      harness.input.dispose();

      pressKey(harness.keyTarget, "ArrowUp");

      expect(harness.onCommand).not.toHaveBeenCalled();
    });

    it("stops firing new-session on click after dispose", () => {
      harness.input.dispose();

      harness.control.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(harness.onNewSession).not.toHaveBeenCalled();
    });

    it("stops firing new-session on Enter after dispose", () => {
      harness.input.dispose();

      pressKey(harness.control, "Enter");

      expect(harness.onNewSession).not.toHaveBeenCalled();
    });
  });
});
