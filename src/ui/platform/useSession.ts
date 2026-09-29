/**
 * `useSession` — React state mirror of the SDK's current auth session.
 *
 * Authentication state drives the whole shell: signed-out Players see the auth
 * screen; signed-in Players see run setup, gameplay, history, and own-rank. The
 * SDK owns the session (`platform.auth.currentSession()`); this hook mirrors it
 * into React state so a sign-in/sign-out re-renders the shell, and exposes a
 * `refresh` the auth screen calls after a successful sign-in/out (R12.3 — clear
 * feedback for authentication state).
 *
 * The hook stays a thin mirror: it never calls the network itself. The auth
 * screen performs the `signIn`/`signOut` calls and then `refresh()`es, keeping
 * this hook deterministic and easy to test.
 */
import { useCallback, useState } from "react";

import type { AuthSession } from "../../client/ports/PlatformClient";
import { usePlatform } from "./PlatformProvider";

export interface SessionState {
  /** The current authenticated session, or `null` when signed out. */
  readonly session: AuthSession | null;
  /** Re-read the SDK's current session into React state. */
  readonly refresh: () => void;
}

export function useSession(): SessionState {
  const platform = usePlatform();
  const [session, setSession] = useState<AuthSession | null>(() =>
    platform.auth.currentSession(),
  );

  const refresh = useCallback(() => {
    setSession(platform.auth.currentSession());
  }, [platform]);

  return { session, refresh };
}
