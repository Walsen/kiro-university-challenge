/**
 * Unit tests for `PlatformSdk` — the client Platform SDK over the ports
 * (task 10.1).
 *
 * The SDK is exercised entirely against a **fake `HttpTransport`** and a **fake
 * `AuthProvider`**, so the tests are deterministic and never touch the network
 * (testing steering "Determinism"). They pin the behaviour the design's Error
 * Handling table promises: a success path for each route, the bearer token
 * attached to authenticated calls, and a distinct typed {@link PlatformFailure}
 * for every failure mode (R12.5) — never an ambiguous throw.
 *
 * Requirements: R4, R5, R6, R12.5.
 */
import { describe, expect, it } from "vitest";

import { PlatformSdk } from "./PlatformSdk";
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../ports/HttpTransport";
import type {
  MazeParams,
  ScoreSubmission,
} from "../ports/PlatformClient";
import type { AuthProvider, AuthSession, SignUpResult } from "../ports";

const BASE_URL = "https://api.dev.example.com";
const TOKEN = "header.payload.signature";

const PARAMS: MazeParams = {
  rows: 11,
  columns: 11,
  seed: 42,
  timeLimitSeconds: 60,
};

const SUBMISSION: ScoreSubmission = {
  mazeParams: PARAMS,
  moves: ["Right", "Down"],
  clientElapsedMs: 1234,
  idempotencyKey: "idem-key-1",
};

/**
 * A fake transport that records the request it received and replays a scripted
 * response (or a rejection, to simulate a genuine connection failure).
 */
class FakeTransport implements HttpTransport {
  public lastRequest: HttpRequest | null = null;
  private response: HttpResponse | null = null;
  private rejection: Error | null = null;

  public willRespond(status: number, body: unknown): void {
    this.response = {
      status,
      body: typeof body === "string" ? body : JSON.stringify(body),
    };
    this.rejection = null;
  }

  public willReject(error: Error): void {
    this.rejection = error;
    this.response = null;
  }

  public send(request: HttpRequest): Promise<HttpResponse> {
    this.lastRequest = request;
    if (this.rejection !== null) {
      return Promise.reject(this.rejection);
    }
    if (this.response === null) {
      throw new Error("FakeTransport: no scripted response");
    }
    return Promise.resolve(this.response);
  }
}

/** A fake auth provider whose current session the test can set directly. */
class FakeAuthProvider implements AuthProvider {
  public session: AuthSession | null = null;
  public signedOut = false;

  public signUp(
    identifier: string,
    _credential: string,
    displayName: string,
  ): Promise<SignUpResult> {
    return Promise.resolve({ identifier, displayName, confirmationRequired: true });
  }
  public confirm(): Promise<void> {
    return Promise.resolve();
  }
  public signIn(): Promise<AuthSession> {
    const session: AuthSession = {
      accessToken: TOKEN,
      displayName: "Player One",
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    this.session = session;
    return Promise.resolve(session);
  }
  public signOut(): Promise<void> {
    this.session = null;
    this.signedOut = true;
    return Promise.resolve();
  }
  public currentSession(): AuthSession | null {
    return this.session;
  }
  public startRecovery(): Promise<void> {
    return Promise.resolve();
  }
  public completeRecovery(): Promise<void> {
    return Promise.resolve();
  }
}

function makeSdk(): {
  sdk: PlatformSdk;
  transport: FakeTransport;
  auth: FakeAuthProvider;
} {
  const transport = new FakeTransport();
  const auth = new FakeAuthProvider();
  const sdk = new PlatformSdk({ baseUrl: BASE_URL, transport, authProvider: auth });
  return { sdk, transport, auth };
}

function withSession(auth: FakeAuthProvider): void {
  auth.session = {
    accessToken: TOKEN,
    displayName: "Player One",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

describe("PlatformSdk auth delegation", () => {
  it("delegates auth methods to the injected AuthProvider (R4/R5/R6 gate on auth)", async () => {
    const { sdk, auth } = makeSdk();

    const signUp = await sdk.auth.signUp("p@example.com", "S3cret!!", "Player One");
    expect(signUp.confirmationRequired).toBe(true);

    const session = await sdk.auth.signIn("p@example.com", "S3cret!!");
    expect(session.accessToken).toBe(TOKEN);
    expect(sdk.auth.currentSession()).toEqual(session);

    await sdk.auth.signOut();
    expect(auth.signedOut).toBe(true);
    expect(sdk.auth.currentSession()).toBeNull();
  });
});

describe("PlatformSdk.submitScore (R4)", () => {
  it("POSTs to /scores with the bearer token and returns the authoritative result", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(201, {
      persisted: true,
      isPersonalBest: true,
      elapsedMs: 500,
    });

    const result = await sdk.submitScore(SUBMISSION);

    expect(result).toEqual({
      ok: true,
      value: { persisted: true, isPersonalBest: true, elapsedMs: 500 },
    });
    const req = transport.lastRequest;
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe(`${BASE_URL}/scores`);
    expect(req?.headers?.["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers?.["content-type"]).toBe("application/json");
    const parsedBody: unknown = JSON.parse(req?.body ?? "null");
    expect(parsedBody).toEqual(SUBMISSION);
  });

  it("treats a 200 idempotent duplicate as a success (R7.4)", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(200, {
      persisted: false,
      isPersonalBest: false,
      elapsedMs: 500,
    });

    const result = await sdk.submitScore(SUBMISSION);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.persisted).toBe(false);
    }
  });

  it("fails 'unauthenticated' without hitting the network when no session exists (R4.3)", async () => {
    const { sdk, transport } = makeSdk();

    const result = await sdk.submitScore(SUBMISSION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("unauthenticated");
      expect(typeof result.failure.message).toBe("string");
    }
    // Fails fast: nothing was sent over the transport (R4.3).
    expect(transport.lastRequest).toBeNull();
  });

  it("maps a 401 to an 'unauthenticated' failure (expired/rejected token)", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(401, { error: "unauthorized" });

    const result = await sdk.submitScore(SUBMISSION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("unauthenticated");
    }
  });

  it("maps a 400 to a 'validation' failure (R4.4)", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(400, { error: "not-a-win" });

    const result = await sdk.submitScore(SUBMISSION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("validation");
      expect(result.failure.message).toContain("not-a-win");
    }
  });

  it("maps a 429 to a 'rate-limited' failure (R7.3)", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(429, { error: "slow down" });

    const result = await sdk.submitScore(SUBMISSION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("rate-limited");
    }
  });

  it("maps a 5xx to a 'backend' failure", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(503, "gateway error");

    const result = await sdk.submitScore(SUBMISSION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("backend");
    }
  });

  it("maps a rejected transport (offline) to a 'network' failure (R12.5)", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willReject(new Error("Failed to fetch"));

    const result = await sdk.submitScore(SUBMISSION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("network");
    }
  });
});

describe("PlatformSdk.personalHistory (R5.1)", () => {
  it("GETs /scores/me with the bearer token and returns the page", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    const page = {
      items: [{ outcome: "Won", mazeParams: PARAMS, elapsedMs: 500 }],
      nextPage: "cursor-2",
    };
    transport.willRespond(200, page);

    const result = await sdk.personalHistory();

    expect(result).toEqual({ ok: true, value: page });
    const req = transport.lastRequest;
    expect(req?.method).toBe("GET");
    expect(req?.url).toBe(`${BASE_URL}/scores/me`);
    expect(req?.headers?.["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("passes the opaque cursor as the ?next= query parameter", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(200, { items: [] });

    await sdk.personalHistory("cursor-2");

    expect(transport.lastRequest?.url).toBe(`${BASE_URL}/scores/me?next=cursor-2`);
  });

  it("fails 'unauthenticated' with no session (R5.3)", async () => {
    const { sdk } = makeSdk();

    const result = await sdk.personalHistory();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("unauthenticated");
    }
  });
});

describe("PlatformSdk.personalBest (R5.2)", () => {
  it("GETs /scores/me/best with the maze-param scope and returns the best", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    const best = { outcome: "Won", mazeParams: PARAMS, elapsedMs: 400 };
    transport.willRespond(200, { best });

    const result = await sdk.personalBest(PARAMS);

    expect(result).toEqual({ ok: true, value: best });
    const req = transport.lastRequest;
    expect(req?.url).toBe(
      `${BASE_URL}/scores/me/best?rows=11&columns=11&seed=42&timeLimitSeconds=60`,
    );
    expect(req?.headers?.["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("returns a null value when the account has no personal best (not a failure)", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(200, { best: null });

    const result = await sdk.personalBest(PARAMS);

    expect(result).toEqual({ ok: true, value: null });
  });
});

describe("PlatformSdk.leaderboard (R6.1)", () => {
  it("GETs the public /leaderboard with the scope and NO bearer token", async () => {
    const { sdk, transport } = makeSdk();
    const standings = [{ rank: 1, displayName: "Ada", timeMs: 300 }];
    transport.willRespond(200, { standings });

    const result = await sdk.leaderboard(PARAMS);

    expect(result).toEqual({ ok: true, value: standings });
    const req = transport.lastRequest;
    expect(req?.method).toBe("GET");
    expect(req?.url).toBe(
      `${BASE_URL}/leaderboard?rows=11&columns=11&seed=42&timeLimitSeconds=60`,
    );
    expect(req?.headers?.["authorization"]).toBeUndefined();
  });

  it("includes the limit query parameter when supplied", async () => {
    const { sdk, transport } = makeSdk();
    transport.willRespond(200, { standings: [] });

    await sdk.leaderboard(PARAMS, 10);

    expect(transport.lastRequest?.url).toBe(
      `${BASE_URL}/leaderboard?rows=11&columns=11&seed=42&timeLimitSeconds=60&limit=10`,
    );
  });

  it("maps a 429 to a 'rate-limited' failure even on the public route", async () => {
    const { sdk, transport } = makeSdk();
    transport.willRespond(429, { error: "slow down" });

    const result = await sdk.leaderboard(PARAMS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("rate-limited");
    }
  });
});

describe("PlatformSdk.ownRank (R6.3)", () => {
  it("GETs /leaderboard/me with the bearer token and returns the ranked marker", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(200, { ranked: true, rank: 3 });

    const result = await sdk.ownRank(PARAMS);

    expect(result).toEqual({ ok: true, value: { ranked: true, rank: 3 } });
    const req = transport.lastRequest;
    expect(req?.url).toBe(
      `${BASE_URL}/leaderboard/me?rows=11&columns=11&seed=42&timeLimitSeconds=60`,
    );
    expect(req?.headers?.["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("returns the unranked marker as a success (R6.3)", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(200, { ranked: false });

    const result = await sdk.ownRank(PARAMS);

    expect(result).toEqual({ ok: true, value: { ranked: false } });
  });

  it("fails 'unauthenticated' with no session", async () => {
    const { sdk } = makeSdk();

    const result = await sdk.ownRank(PARAMS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("unauthenticated");
    }
  });
});

describe("PlatformSdk malformed success body", () => {
  it("maps an unparseable 200 body to a 'backend' failure (R12.5)", async () => {
    const { sdk, transport, auth } = makeSdk();
    withSession(auth);
    transport.willRespond(200, "not json{");

    const result = await sdk.personalBest(PARAMS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("backend");
    }
  });
});
