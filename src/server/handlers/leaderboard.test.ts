/**
 * Unit tests for the leaderboard handlers `GET /leaderboard` and
 * `GET /leaderboard/me` (task 7.3) against an in-memory {@link LeaderboardQuery}
 * fake.
 *
 * No AWS: the handlers are the orchestration seam (parse the maze-parameter
 * scope, call the ranked-read port, shape a JSON response), so they are
 * exercised with a fake query and plain event objects — the same pattern as the
 * Score handler (task 7.1). The real dev-stack seam is task 7.4.
 *
 * Acceptance criteria under test:
 *  - R6.1 — the public leaderboard returns standings ascending by time, fastest
 *    first.
 *  - R6.2 — each standing carries the Player-chosen display name.
 *  - R6.3 — an authenticated own-rank read returns the caller's rank, or a clear
 *    unranked indication.
 *  - R11.3 — the public leaderboard response NEVER exposes the private account
 *    identifier; only display name + time + rank.
 *  - The public route is unauthenticated; `/leaderboard/me` requires an account
 *    (401 without one). Both require a well-formed maze-parameter scope (400
 *    when missing/malformed).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  makeLeaderboardHandler,
  makeOwnRankHandler,
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
} from "./leaderboard";
import type { HttpApiEvent } from "./http";
import type {
  LeaderboardQuery,
  LeaderboardStanding,
} from "../ports/ScoreRepository";
import type { MazeParams } from "../../core/validateSubmission";
import {
  computeOwnRank,
  type LeaderboardEntry,
  type OwnRankResult,
} from "../../core/platform/leaderboard";

// ---------------------------------------------------------------------------
// A recording in-memory LeaderboardQuery fake (mirrors ScoreRepository.test.ts)
// ---------------------------------------------------------------------------

/** Stable string identity for a maze-parameter scope, used to bucket entries. */
function paramsKey(params: MazeParams): string {
  return `${params.rows}x${params.columns}#${params.seed}#${params.timeLimitSeconds}`;
}

class FakeLeaderboardQuery implements LeaderboardQuery {
  /** Records the limit the handler passed, so the cap/default can be asserted. */
  public lastLimit: number | null = null;

  private readonly entries = new Map<
    string,
    Array<{ accountId: string; displayName: string; timeMs: number }>
  >();

  add(params: MazeParams, accountId: string, displayName: string, timeMs: number): void {
    const key = paramsKey(params);
    const list = this.entries.get(key) ?? [];
    list.push({ accountId, displayName, timeMs });
    this.entries.set(key, list);
  }

  topN(params: MazeParams, limit: number): Promise<ReadonlyArray<LeaderboardStanding>> {
    this.lastLimit = limit;
    const list = [...(this.entries.get(paramsKey(params)) ?? [])].sort(
      (a, b) => a.timeMs - b.timeMs || a.accountId.localeCompare(b.accountId),
    );
    const standings: LeaderboardStanding[] = list.slice(0, limit).map((e, index) => ({
      rank: index + 1,
      displayName: e.displayName,
      timeMs: e.timeMs,
      accountId: e.accountId,
    }));
    return Promise.resolve(standings);
  }

  ownRank(params: MazeParams, accountId: string): Promise<OwnRankResult> {
    const list = this.entries.get(paramsKey(params)) ?? [];
    const leaderboardEntries: ReadonlyArray<LeaderboardEntry> = list.map((e) => ({
      accountId: e.accountId,
      timeMs: e.timeMs,
    }));
    return Promise.resolve(computeOwnRank(leaderboardEntries, accountId));
  }
}

// ---------------------------------------------------------------------------
// Fixtures and event builders
// ---------------------------------------------------------------------------

const PARAMS: MazeParams = { rows: 6, columns: 6, seed: 1234, timeLimitSeconds: 120 };
const ACCOUNT_ID = "cognito-sub-abc";

/** The four query keys that encode a `MazeParams` scope. */
function scopeQuery(params: MazeParams): Record<string, string> {
  return {
    rows: String(params.rows),
    columns: String(params.columns),
    seed: String(params.seed),
    timeLimitSeconds: String(params.timeLimitSeconds),
  };
}

/** A public (unauthenticated) event carrying a scope and optional extra query. */
function publicEvent(
  query: Record<string, string> | null,
  extra: Record<string, string> = {},
): HttpApiEvent {
  return {
    queryStringParameters: query === null ? {} : { ...query, ...extra },
  };
}

/** An authenticated event carrying a scope and a JWT `sub` claim. */
function authedEvent(
  query: Record<string, string> | null,
  sub: string | null = ACCOUNT_ID,
): HttpApiEvent {
  return {
    queryStringParameters: query === null ? {} : query,
    requestContext:
      sub === null
        ? { authorizer: { jwt: { claims: {} } } }
        : { authorizer: { jwt: { claims: { sub } } } },
  };
}

// ---------------------------------------------------------------------------
// GET /leaderboard (public top-N)
// ---------------------------------------------------------------------------

describe("GET /leaderboard handler", () => {
  let query: FakeLeaderboardQuery;

  beforeEach(() => {
    query = new FakeLeaderboardQuery();
  });

  it("returns standings ascending by time, fastest first (R6.1)", async () => {
    query.add(PARAMS, "acct-a", "Ada", 3_000);
    query.add(PARAMS, "acct-b", "Bo", 1_000);
    query.add(PARAMS, "acct-c", "Cy", 2_000);
    const handler = makeLeaderboardHandler({ query });

    const result = await handler(publicEvent(scopeQuery(PARAMS)));
    const payload = JSON.parse(result.body) as {
      standings: Array<{ rank: number; displayName: string; timeMs: number }>;
    };

    expect(result.statusCode).toBe(200);
    expect(payload.standings.map((s) => s.displayName)).toEqual(["Bo", "Cy", "Ada"]);
    expect(payload.standings.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it("presents each standing with a display name (R6.2)", async () => {
    query.add(PARAMS, "acct-a", "Ada", 3_000);
    const handler = makeLeaderboardHandler({ query });

    const result = await handler(publicEvent(scopeQuery(PARAMS)));
    const payload = JSON.parse(result.body) as {
      standings: Array<{ displayName: string }>;
    };

    expect(payload.standings[0]?.displayName).toBe("Ada");
  });

  it("NEVER exposes the private account identifier in the public response (R11.3)", async () => {
    query.add(PARAMS, "acct-secret", "Ada", 3_000);
    const handler = makeLeaderboardHandler({ query });

    const result = await handler(publicEvent(scopeQuery(PARAMS)));

    // The raw body must not contain the accountId anywhere, and each item must
    // carry only the public projection (rank, displayName, timeMs).
    expect(result.body).not.toContain("acct-secret");
    const payload = JSON.parse(result.body) as { standings: unknown[] };
    for (const standing of payload.standings) {
      expect(standing).not.toHaveProperty("accountId");
      expect(Object.keys(standing as object).sort()).toEqual([
        "displayName",
        "rank",
        "timeMs",
      ]);
    }
  });

  it("projects by allow-list, so any extra private field the port adds is dropped (R11.3)", async () => {
    // The port grows a private field (here an email + raw accountId). The public
    // projection is an allow-list of display name + time + rank, so a NEW private
    // field can never leak into the public response even as the port's shape
    // evolves — the boundary is closed by construction, not by blocking known
    // keys.
    const leaky: LeaderboardStanding & { email: string } = {
      rank: 1,
      displayName: "Ada",
      timeMs: 3_000,
      accountId: "acct-private-id",
      email: "ada@example.com",
    };
    const leakyQuery: LeaderboardQuery = {
      topN: () => Promise.resolve([leaky]),
      ownRank: () => Promise.resolve({ ranked: false }),
    };
    const handler = makeLeaderboardHandler({ query: leakyQuery });

    const result = await handler(publicEvent(scopeQuery(PARAMS)));

    expect(result.body).not.toContain("acct-private-id");
    expect(result.body).not.toContain("ada@example.com");
    const payload = JSON.parse(result.body) as { standings: unknown[] };
    expect(Object.keys(payload.standings[0] as object).sort()).toEqual([
      "displayName",
      "rank",
      "timeMs",
    ]);
  });

  it("is public: serves standings with no authenticated account", async () => {
    query.add(PARAMS, "acct-a", "Ada", 3_000);
    const handler = makeLeaderboardHandler({ query });

    const result = await handler(publicEvent(scopeQuery(PARAMS)));

    expect(result.statusCode).toBe(200);
  });

  it("defaults the limit when none is supplied", async () => {
    const handler = makeLeaderboardHandler({ query });

    await handler(publicEvent(scopeQuery(PARAMS)));

    expect(query.lastLimit).toBe(DEFAULT_LEADERBOARD_LIMIT);
  });

  it("honors a supplied in-range limit", async () => {
    const handler = makeLeaderboardHandler({ query });

    await handler(publicEvent(scopeQuery(PARAMS), { limit: "5" }));

    expect(query.lastLimit).toBe(5);
  });

  it("caps an oversized limit at the maximum (R6.4 bounded read)", async () => {
    const handler = makeLeaderboardHandler({ query });

    await handler(publicEvent(scopeQuery(PARAMS), { limit: String(MAX_LEADERBOARD_LIMIT + 100) }));

    expect(query.lastLimit).toBe(MAX_LEADERBOARD_LIMIT);
  });

  it("rejects a non-positive limit as a bad request (400)", async () => {
    const handler = makeLeaderboardHandler({ query });

    const result = await handler(publicEvent(scopeQuery(PARAMS), { limit: "0" }));

    expect(result.statusCode).toBe(400);
    expect(query.lastLimit).toBeNull();
  });

  it("rejects a non-integer limit as a bad request (400)", async () => {
    const handler = makeLeaderboardHandler({ query });

    const result = await handler(publicEvent(scopeQuery(PARAMS), { limit: "abc" }));

    expect(result.statusCode).toBe(400);
  });

  it("rejects a missing maze-parameter scope (400)", async () => {
    const handler = makeLeaderboardHandler({ query });

    const result = await handler(publicEvent(null));

    expect(result.statusCode).toBe(400);
    expect(query.lastLimit).toBeNull();
  });

  it("rejects a malformed maze-parameter scope (400)", async () => {
    const handler = makeLeaderboardHandler({ query });

    const result = await handler(publicEvent({ ...scopeQuery(PARAMS), rows: "not-int" }));

    expect(result.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /leaderboard/me (authenticated own-rank)
// ---------------------------------------------------------------------------

describe("GET /leaderboard/me handler", () => {
  let query: FakeLeaderboardQuery;

  beforeEach(() => {
    query = new FakeLeaderboardQuery();
  });

  it("returns the caller's own rank for the scope (R6.3)", async () => {
    query.add(PARAMS, "acct-a", "Ada", 3_000);
    query.add(PARAMS, ACCOUNT_ID, "Me", 1_000);
    const handler = makeOwnRankHandler({ query });

    const result = await handler(authedEvent(scopeQuery(PARAMS)));
    const payload = JSON.parse(result.body) as { ranked: boolean; rank?: number };

    expect(result.statusCode).toBe(200);
    expect(payload).toEqual({ ranked: true, rank: 1 });
  });

  it("indicates the caller is unranked when they have no entry (R6.3)", async () => {
    query.add(PARAMS, "acct-a", "Ada", 3_000);
    const handler = makeOwnRankHandler({ query });

    const result = await handler(authedEvent(scopeQuery(PARAMS)));
    const payload = JSON.parse(result.body) as { ranked: boolean };

    expect(result.statusCode).toBe(200);
    expect(payload).toEqual({ ranked: false });
  });

  it("takes the account from the JWT sub, never a client field (R11.2)", async () => {
    query.add(PARAMS, "acct-a", "Ada", 1_000);
    query.add(PARAMS, "sub-xyz", "Other", 2_000);
    const handler = makeOwnRankHandler({ query });

    // ranked 2 (one strictly-better time from acct-a) proves the sub identity
    // was used to look up the caller's own rank.
    const result = await handler(authedEvent(scopeQuery(PARAMS), "sub-xyz"));
    const payload = JSON.parse(result.body) as { ranked: boolean; rank?: number };

    expect(payload).toEqual({ ranked: true, rank: 2 });
  });

  it("ignores a client-supplied accountId query param, ranking the JWT sub (R11.2)", async () => {
    query.add(PARAMS, "acct-a", "Ada", 1_000);
    query.add(PARAMS, "acct-b", "Bo", 2_000);
    query.add(PARAMS, ACCOUNT_ID, "Me", 3_000);
    const handler = makeOwnRankHandler({ query });

    // The caller injects an accountId query param pointing at the fastest row,
    // trying to be ranked as someone else. The handler passes only the JWT sub
    // to the port, so the caller is ranked 3 (two strictly-better times), the
    // rank of its OWN entry — not rank 1 of the impersonated account.
    const event: HttpApiEvent = {
      queryStringParameters: { ...scopeQuery(PARAMS), accountId: "acct-a", sub: "acct-a" },
      requestContext: { authorizer: { jwt: { claims: { sub: ACCOUNT_ID } } } },
    };
    const result = await handler(event);
    const payload = JSON.parse(result.body) as { ranked: boolean; rank?: number };

    expect(payload).toEqual({ ranked: true, rank: 3 });
  });

  it("rejects a request with no authenticated account (401)", async () => {
    const handler = makeOwnRankHandler({ query });

    const result = await handler(authedEvent(scopeQuery(PARAMS), null));

    expect(result.statusCode).toBe(401);
  });

  it("rejects a missing maze-parameter scope (400)", async () => {
    const handler = makeOwnRankHandler({ query });

    const result = await handler(authedEvent(null));

    expect(result.statusCode).toBe(400);
  });

  it("checks identity before the scope: no account is 401 even without a scope", async () => {
    const handler = makeOwnRankHandler({ query });

    const result = await handler(authedEvent(null, null));

    expect(result.statusCode).toBe(401);
  });
});
