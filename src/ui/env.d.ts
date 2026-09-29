/// <reference types="vite/client" />

/**
 * Build-time configuration the UI composition root reads (task 10.2).
 *
 * These are injected by Vite at build time from the environment (per-branch
 * values come from the Amplify Hosting branch environment; local `vite dev`
 * falls back to defaults). They are public SPA config only — the user pool ID,
 * the public (secret-less) app client ID, and the API base URL — never secrets.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
