/**
 * UI composition root (task 10.2).
 *
 * The single place the React shell constructs the *concrete* platform adapters
 * and injects them behind the {@link PlatformClient} port — mirroring how
 * `src/main.ts` is the composition root for the maze core. Nothing else in the
 * UI references `PlatformSdk`, `CognitoAuthProvider`, `FetchHttpTransport`, or
 * `fetch`; every screen depends only on the port via {@link PlatformProvider}.
 *
 * Build-time config (`import.meta.env`) supplies the API base URL and the public
 * Cognito pool/client IDs (see `env.d.ts`); per-environment values come from the
 * Amplify Hosting branch environment. This module only runs in the browser
 * (guarded on a real `document`), so importing the shell in a test does not
 * construct AWS adapters — tests inject a fake `PlatformClient` directly.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import {
  AmazonCognitoClient,
  CognitoAuthProvider,
  FetchHttpTransport,
  PlatformSdk,
} from "../client/edges";
import type { PlatformClient } from "../client/ports/PlatformClient";
import { App } from "./App";
import { PlatformProvider } from "./platform/PlatformProvider";

import "./styles.css";

/** The DOM id the SPA mounts into (see `index.html`). */
const ROOT_ELEMENT_ID = "root";

/** Construct the real platform SDK from build-time configuration. */
function buildPlatformClient(): PlatformClient {
  const authProvider = new CognitoAuthProvider(
    new AmazonCognitoClient({
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "",
      clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
    }),
  );
  return new PlatformSdk({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
    transport: new FetchHttpTransport(),
    authProvider,
  });
}

export function mount(container: HTMLElement, client: PlatformClient): void {
  createRoot(container).render(
    <StrictMode>
      <PlatformProvider client={client}>
        <App />
      </PlatformProvider>
    </StrictMode>,
  );
}

// Auto-run only as the browser page entry point. Guarded so importing this
// module (e.g. in a test) does not construct AWS adapters or touch the DOM.
if (typeof document !== "undefined") {
  const container = document.getElementById(ROOT_ELEMENT_ID);
  if (container !== null) {
    mount(container, buildPlatformClient());
  }
}
