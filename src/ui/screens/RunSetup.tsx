/**
 * `RunSetup` — choose the maze parameters that define a Run and its leaderboard
 * scope (task 10.2, R12.1/R12.3).
 *
 * Per the adopted defaults, "maze parameters = size + seed defines a leaderboard
 * scope" and the time limit is player-selectable within the branded bounds. This
 * screen lets the Player pick size and time limit and starts a Run, producing a
 * {@link MazeParams} the shell threads to the leaderboard, own-rank, personal
 * best, and (in task 10.3) score submission.
 *
 * It is a pure form over plain data — no platform calls — so it stays trivially
 * testable. Validation uses the shared bounds from `core` so the UI cannot offer
 * a time limit the core would reject.
 */
import { useState } from "react";

import {
  MAX_TIME_LIMIT_SECONDS,
  MIN_TIME_LIMIT_SECONDS,
  DEFAULT_TIME_LIMIT_SECONDS,
} from "../../core";
import type { MazeParams } from "../../client/ports/PlatformClient";

/** Preset maze sizes (odd dimensions give a true corner exit, per `main.ts`). */
const SIZE_PRESETS = [
  { id: "small", label: "Small (15×15)", rows: 15, columns: 15 },
  { id: "medium", label: "Medium (21×21)", rows: 21, columns: 21 },
  { id: "large", label: "Large (31×31)", rows: 31, columns: 31 },
] as const;

type SizePresetId = (typeof SIZE_PRESETS)[number]["id"];

export interface RunSetupProps {
  /** Start a Run with the chosen scope; the shell routes to gameplay. */
  readonly onStartRun: (params: MazeParams) => void;
}

export function RunSetup({ onStartRun }: RunSetupProps): JSX.Element {
  const [sizeId, setSizeId] = useState<SizePresetId>("medium");
  const [timeLimitSeconds, setTimeLimitSeconds] = useState<number>(
    DEFAULT_TIME_LIMIT_SECONDS,
  );

  function handleStart(): void {
    const size = SIZE_PRESETS.find((preset) => preset.id === sizeId) ?? SIZE_PRESETS[1];
    onStartRun({
      rows: size.rows,
      columns: size.columns,
      // A fresh seed per Run defines this Run's leaderboard scope. Task 10.3
      // captures the actual seed the played maze used for submission; here it
      // seeds the scope the Player is about to race in.
      seed: Date.now() % 1_000_000,
      timeLimitSeconds,
    });
  }

  return (
    <section className="screen run-setup" aria-labelledby="run-setup-heading">
      <h2 id="run-setup-heading">New run</h2>

      <fieldset className="field">
        <legend>Maze size</legend>
        {SIZE_PRESETS.map((preset) => (
          <label key={preset.id} className="radio">
            <input
              type="radio"
              name="maze-size"
              value={preset.id}
              checked={sizeId === preset.id}
              onChange={() => setSizeId(preset.id)}
            />
            {preset.label}
          </label>
        ))}
      </fieldset>

      <div className="field">
        <label htmlFor="run-time-limit">
          Time limit: {timeLimitSeconds}s
        </label>
        <input
          id="run-time-limit"
          type="range"
          min={MIN_TIME_LIMIT_SECONDS}
          max={MAX_TIME_LIMIT_SECONDS}
          step={1}
          value={timeLimitSeconds}
          onChange={(event) => setTimeLimitSeconds(Number(event.target.value))}
        />
        <p className="field__hint">
          Between {MIN_TIME_LIMIT_SECONDS} and {MAX_TIME_LIMIT_SECONDS} seconds.
        </p>
      </div>

      <button type="button" className="btn btn--primary" onClick={handleStart}>
        Start run
      </button>
    </section>
  );
}
