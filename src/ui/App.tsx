/**
 * `App` — the React SPA shell that composes the platform screens around the
 * Canvas maze island (task 10.2, R12.1/R12.3).
 *
 * ## Structure
 *
 * The shell is auth-gated. Signed out, it shows the {@link AuthScreen}; the
 * public {@link LeaderboardScreen} is also reachable so anyone can view
 * standings (R6.1). Signed in, a small tab navigation switches between:
 *   - **Play** — {@link RunSetup} to choose a scope, then {@link GameplayScreen}
 *     hosting the Canvas island for the actual Run;
 *   - **Scores** — {@link ScoreHistoryScreen} (personal history + best);
 *   - **Leaderboard** — {@link LeaderboardScreen} (top-N + own-rank).
 *
 * Authentication state is mirrored from the SDK via {@link useSession}; a
 * successful sign-in/out refreshes it and the shell re-routes, giving clear
 * feedback for auth state (R12.3). The current {@link MazeParams} scope chosen in
 * run setup is held here and threaded to the scores and leaderboard screens so
 * every screen agrees on which scope is in view.
 *
 * The shell owns layout and routing only; it holds no game rules and no platform
 * transport. It leaves the task-10.3 seam untouched: {@link GameplayScreen}
 * accepts an `onWiredGame` the shell does not supply here.
 */
import { useState } from "react";

import type { MazeParams } from "../client/ports/PlatformClient";
import { useSession } from "./platform/useSession";
import { usePlatform } from "./platform/PlatformProvider";
import { AuthScreen } from "./screens/AuthScreen";
import { RunSetup } from "./screens/RunSetup";
import { GameplayScreen } from "./screens/GameplayScreen";
import { ScoreHistoryScreen } from "./screens/ScoreHistoryScreen";
import { LeaderboardScreen } from "./screens/LeaderboardScreen";

/** The signed-in tabs. `gameplay` is entered from `play` once a Run starts. */
type Tab = "play" | "scores" | "leaderboard";

export function App(): JSX.Element {
  const platform = usePlatform();
  const { session, refresh } = useSession();

  const [tab, setTab] = useState<Tab>("play");
  // The scope chosen in run setup and shared with scores/leaderboard. Null until
  // the first run is set up; a sensible default scope is used for the public
  // leaderboard when signed out.
  const [scope, setScope] = useState<MazeParams | null>(null);
  const [inRun, setInRun] = useState(false);

  const signedIn = session !== null;

  async function handleSignOut(): Promise<void> {
    await platform.auth.signOut();
    refresh();
    setInRun(false);
    setTab("play");
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Maze Game</h1>
        <div className="app__session">
          {signedIn ? (
            <>
              <span className="app__display-name">{session.displayName}</span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void handleSignOut();
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <span className="app__display-name app__display-name--muted">
              Signed out
            </span>
          )}
        </div>
      </header>

      {signedIn ? (
        <nav className="app__tabs" aria-label="Main">
          <TabButton current={tab} tab="play" onSelect={setTab}>
            Play
          </TabButton>
          <TabButton current={tab} tab="scores" onSelect={setTab}>
            Scores
          </TabButton>
          <TabButton current={tab} tab="leaderboard" onSelect={setTab}>
            Leaderboard
          </TabButton>
        </nav>
      ) : null}

      <main className="app__main">
        {signedIn ? (
          <SignedInRoutes
            tab={tab}
            scope={scope}
            inRun={inRun}
            onStartRun={(params) => {
              setScope(params);
              setInRun(true);
            }}
            onBackToSetup={() => setInRun(false)}
          />
        ) : (
          <SignedOutRoutes
            scope={scope}
            onAuthenticated={() => {
              refresh();
              setTab("play");
            }}
          />
        )}
      </main>
    </div>
  );
}

/** Signed-in screen routing. */
function SignedInRoutes({
  tab,
  scope,
  inRun,
  onStartRun,
  onBackToSetup,
}: {
  readonly tab: Tab;
  readonly scope: MazeParams | null;
  readonly inRun: boolean;
  readonly onStartRun: (params: MazeParams) => void;
  readonly onBackToSetup: () => void;
}): JSX.Element {
  if (tab === "play") {
    if (inRun && scope !== null) {
      return <GameplayScreen params={scope} onBack={onBackToSetup} />;
    }
    return <RunSetup onStartRun={onStartRun} />;
  }
  if (tab === "scores") {
    return scope === null ? (
      <NeedRunNotice what="your scores" />
    ) : (
      <ScoreHistoryScreen params={scope} />
    );
  }
  return scope === null ? (
    <NeedRunNotice what="the leaderboard" />
  ) : (
    <LeaderboardScreen params={scope} showOwnRank />
  );
}

/** Signed-out routing: auth plus the public leaderboard when a scope exists. */
function SignedOutRoutes({
  scope,
  onAuthenticated,
}: {
  readonly scope: MazeParams | null;
  readonly onAuthenticated: () => void;
}): JSX.Element {
  return (
    <div className="signed-out">
      <AuthScreen onAuthenticated={onAuthenticated} />
      {scope !== null ? (
        <LeaderboardScreen params={scope} showOwnRank={false} />
      ) : null}
    </div>
  );
}

function NeedRunNotice({ what }: { readonly what: string }): JSX.Element {
  return (
    <section className="screen">
      <p className="empty">Set up and start a run to choose a scope for {what}.</p>
    </section>
  );
}

function TabButton({
  current,
  tab,
  onSelect,
  children,
}: {
  readonly current: Tab;
  readonly tab: Tab;
  readonly onSelect: (tab: Tab) => void;
  readonly children: string;
}): JSX.Element {
  const active = current === tab;
  return (
    <button
      type="button"
      className={active ? "tab tab--active" : "tab"}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(tab)}
    >
      {children}
    </button>
  );
}
