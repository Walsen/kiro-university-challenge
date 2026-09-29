import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite build for the React SPA shell (task 10.2).
 *
 * The React chrome (auth, run setup, score history, leaderboard) is bundled by
 * Vite; the Phase 1 maze core is embedded unchanged as a Canvas island inside
 * it. The entry point is `index.html`, which loads `src/ui/main.tsx`.
 *
 * `VITE_API_BASE_URL` (build-time env) provides the Platform API base URL the
 * SDK is constructed with in the UI composition root. Per-environment values
 * come from the Amplify Hosting branch environment (design "Deployment Gates &
 * Environments"); it falls back to a local default for `vite dev`.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
  },
});
