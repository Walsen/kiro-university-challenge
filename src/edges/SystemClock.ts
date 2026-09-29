/**
 * `SystemClock` — impure edge adapter implementing the `Clock` port.
 *
 * Wraps the browser's `performance.now()` to provide a monotonic millisecond
 * time source used only for elapsed-time deltas. Living at the edge, it is the
 * one place allowed to touch the global `performance` API, keeping the core and
 * application layers free of direct timing access (Dependency Inversion). Tests
 * substitute a `FakeClock` in its place.
 *
 * Single Responsibility: expose monotonic time and nothing else.
 *
 * _Requirements: 3.1_
 */
import type { Clock } from "./ports";

export class SystemClock implements Clock {
  /** Monotonic time in milliseconds from `performance.now()`. */
  now(): number {
    return performance.now();
  }
}
