/**
 * Client edges layer entry point.
 *
 * Concrete adapters implementing the client ports against the outside world
 * (AWS). Only modules here reference provider SDKs; the rest of the client
 * depends on the ports in `../ports`. See `.kiro/steering/architecture.md`.
 */
export { CognitoAuthProvider } from "./CognitoAuthProvider";
export {
  AmazonCognitoClient,
  type CognitoClient,
  type CognitoClientConfig,
  type CognitoTokens,
} from "./cognitoClient";
