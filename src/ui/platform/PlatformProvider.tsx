/**
 * `PlatformProvider` / `usePlatform` — the React seam onto the client Platform
 * SDK (task 10.2).
 *
 * The whole React shell depends only on the {@link PlatformClient} *port*, never
 * on `fetch`, Cognito, or the concrete `PlatformSdk`. This provider makes one
 * injected `PlatformClient` available to every screen via context, so:
 *
 *  - components read auth/score/leaderboard capability through `usePlatform()`,
 *    exactly the Dependency-Inversion boundary the design draws (the UI "depends
 *    only on this port");
 *  - tests render any screen wrapped in this provider with a **fake**
 *    `PlatformClient`, so smoke/render tests are deterministic and never touch
 *    the network (testing steering "Determinism").
 *
 * The composition root (`src/ui/main.tsx`) is the only place that constructs the
 * real `PlatformSdk` and passes it here.
 */
import { createContext, useContext, type ReactNode } from "react";

import type { PlatformClient } from "../../client/ports/PlatformClient";

const PlatformContext = createContext<PlatformClient | null>(null);

export interface PlatformProviderProps {
  /** The platform capability the whole shell depends on (injected). */
  readonly client: PlatformClient;
  readonly children: ReactNode;
}

export function PlatformProvider({
  client,
  children,
}: PlatformProviderProps): JSX.Element {
  return (
    <PlatformContext.Provider value={client}>{children}</PlatformContext.Provider>
  );
}

/**
 * Read the injected {@link PlatformClient}. Throws if used outside a
 * {@link PlatformProvider} — a programming error (a screen mounted without the
 * platform wired) that should fail fast rather than silently no-op.
 */
export function usePlatform(): PlatformClient {
  const client = useContext(PlatformContext);
  if (client === null) {
    throw new Error(
      "usePlatform must be used within a <PlatformProvider>. Wrap the app (or the test) in one.",
    );
  }
  return client;
}
