/**
 * Client ports layer entry point.
 *
 * The small, provider-agnostic interfaces the Phase 2 client depends on for its
 * platform capabilities. Concrete adapters (e.g. `CognitoAuthProvider`) live in
 * the client edges layer and implement these ports; dependencies point inward
 * only. See `.kiro/steering/architecture.md`.
 */
export type { AuthProvider, AuthSession, SignUpResult } from "./AuthProvider";
