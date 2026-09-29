/**
 * Unit tests for the personal-history handlers `GET /scores/me` and
 * `GET /scores/me/best` (task 7.2) against an in-memory {@link ScoreRepository}
 * fake.
 *
 * No AWS: these handlers are pure orchestration seams (read the caller's account
 * from the JWT, read scoped data via the port, shape JSON), so they are
 * exercised with a fake repo and plain event objects. The real dev-stack seam is
 * task 7.4.
 *
 * Acceptance criteria under test:
 *  - R5.1 — `GET /scores/me` returns a page of ONLY the caller's own scores, and
 *    surfaces the next-page cursor when the repository reports one.
 *  - R5.2 — `GET /scores/me/best` returns the caller's personal best for a maze-
 *    parameter scope, or a clear "none exists" indication when there is no entry.
 *  - R5.3 / R11.2 — per-account isolation: every read is scoped to the JWT `sub`,
 *    so two different callers see disjoint data and no client-supplied field can
 *    widen the scope. A request with no account identity is rejected (401).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  makePersonalBestHandler,
  makePersonalHistoryHandler,
} from "./personalHistory";
import type { HttpApiEvent } from "./http";
import type {
  Page,
  PageToken,
  PutScoreResult,
  ScoreRepository,
} from "../ports/ScoreRepository";
import type { MazeParams, Score } from "../../core/validateSubmission";

// ---------------------------------------------------------------------------
// A recording in-memory ScoreRepository fake that enforces per-account scoping
// ---------------------------------------------------------------------------

/**
 * The fake stores scores keyed by account so a `listByAccount`/`personalBest`
 * for one account can never see another's — this lets the isolation tests prove
 * the handler passes the JWT `sub` through unchanged rather than the fake merely
 * pretending to isolate.
 */
class FakeScoreRepository implements ScoreRepository {
  /** account id -> that account's scores. */
  private readonly byAccount = new Map<string, Score[]>();
  /** Records the (accountId, page) each list call was scoped to. */
  public readonly listCalls: Array<{
    accountId: string;
    page: PageToken | undefined;
  }> = [];
  /** Records the (accountId, params) each best call was scoped to. */
  public readonly bestCalls: Array<{ accountId: string; params: MazeParams }> = [];
  /** When set, the next `listByAccount` returns this cursor as `nextPage`. */
  public nextPageToReturn?: PageToken;

  public seed(accountId: string, scores: Score[]): void {
    this.byAccount.set(accountId, scores);
  }

  // Not exercised by these read tests; present to satisfy the port.
  public putScore(): Promise<PutScoreResult> {
    return Promise.resolve({ persisted: true, isPersonalBest: true });
  }

  public personalBest(accountId: string, params: MazeParams): Promise<Score | null> {
    this.bestCalls.push({ accountId, params });
    const scores = this.byAccount.get(accountId) ?? [];
    const match = scores
      .filter((s) => sameParams(s.mazeParams, params))
      .sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
    return Promise.resolve(match ?? null);
  }

  public listByAccount(accountId: string, page?: PageToken): Promise<Page<Score>> {
    this.listCalls.push({ accountId, page });
    const items = this.byAccount.get(accountId) ?? [];
    return Promise.resolve(
      this.nextPageToReturn === undefined
        ? { items }
        : { items, nextPage: this.nextPageToReturn },
    );
  }
}

function sameParams(a: MazeParams, b: MazeParams): boolean {
  return (
    a.rows === b.rows &&
    a.columns === b.columns &&
    a.seed === b.seed &&
    a.timeLimitSeconds === b.timeLimitSeconds
  );
}

// ---------------------------------------------------------------------------
// Fixtures + event builders
// ---------------------------------------------------------------------------

const ACCOUNT_A = "cognito-sub-aaa";
const ACCOUNT_B = "cognito-sub-bbb";

const PARAMS: MazeParams = { rows: 6, columns: 6, seed: 1234, timeLimitSeconds: 120 };

function score(elapsedMs: number, params: MazeParams = PARAMS): Score {
  return { outcome: "Won", mazeParams: params, elapsedMs };
}

function authedEvent(
  sub: string | null,
  query?: Record<string, string | undefined>,
): HttpApiEvent {
  return {
    queryStringParameters: query ?? null,
    requestContext:
      sub === null
        ? {}
        : { authorizer: { jwt: { claims: { sub } } } },
  };
}

function mazeQuery(params: MazeParams): Record<string, string> {
  return {
    rows: String(params.rows),
    columns: String(params.columns),
    seed: String(params.seed),
    timeLimitSeconds: String(params.timeLimitSeconds),
  };
}

// ---------------------------------------------------------------------------
// GET /scores/me
// ---------------------------------------------------------------------------

describe("GET /scores/me handler", () => {
  let repo: FakeScoreRepository;

  beforeEach(() => {
    repo = new FakeScoreRepository();
  });

  it("returns only the caller's own scores, scoped to the JWT sub (R5.1, R11.2)", async () => {
    repo.seed(ACCOUNT_A, [score(1000), score(2000)]);
    repo.seed(ACCOUNT_B, [score(500)]);
    const handler = makePersonalHistoryHandler({ repository: repo });

    const result = await handler(authedEvent(ACCOUNT_A));
    const payload = JSON.parse(result.body) as { items: Score[] };

    expect(result.statusCode).toBe(200);
    expect(payload.items).toHaveLength(2);
    // The read was scoped to the caller's own sub, never a client field.
    expect(repo.listCalls).toEqual([{ accountId: ACCOUNT_A, page: undefined }]);
  });

  it("two different callers see disjoint data (R5.3, R11.2)", async () => {
    repo.seed(ACCOUNT_A, [score(1000)]);
    repo.seed(ACCOUNT_B, [score(2000), score(3000)]);
    const handler = makePersonalHistoryHandler({ repository: repo });

    const a = JSON.parse((await handler(authedEvent(ACCOUNT_A))).body) as {
      items: Score[];
    };
    const b = JSON.parse((await handler(authedEvent(ACCOUNT_B))).body) as {
      items: Score[];
    };

    expect(a.items).toHaveLength(1);
    expect(a.items[0]?.elapsedMs).toBe(1000);
    expect(b.items).toHaveLength(2);
    expect(b.items.map((s) => s.elapsedMs)).not.toContain(1000);
  });

  it("ignores a client-supplied accountId query param, reading only the JWT sub's scope (R11.2)", async () => {
    repo.seed(ACCOUNT_A, [score(1000)]);
    repo.seed(ACCOUNT_B, [score(2000), score(3000)]);
    const handler = makePersonalHistoryHandler({ repository: repo });

    // Caller A tries to widen the read to B by supplying an accountId param. The
    // handler derives the account only from the JWT sub, so the injected id is
    // inert: A still sees only A's scores.
    const result = await handler(
      authedEvent(ACCOUNT_A, { accountId: ACCOUNT_B, sub: ACCOUNT_B }),
    );
    const payload = JSON.parse(result.body) as { items: Score[] };

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.elapsedMs).toBe(1000);
    expect(repo.listCalls).toEqual([{ accountId: ACCOUNT_A, page: undefined }]);
  });

  it("surfaces the next-page cursor when the repository reports one (R5.1)", async () => {
    repo.seed(ACCOUNT_A, [score(1000)]);
    repo.nextPageToReturn = "opaque-cursor-1" as PageToken;
    const handler = makePersonalHistoryHandler({ repository: repo });

    const result = await handler(authedEvent(ACCOUNT_A));
    const payload = JSON.parse(result.body) as { nextPage?: string };

    expect(payload.nextPage).toBe("opaque-cursor-1");
  });

  it("passes the requested page cursor through to the repository (R5.1)", async () => {
    repo.seed(ACCOUNT_A, [score(1000)]);
    const handler = makePersonalHistoryHandler({ repository: repo });

    await handler(authedEvent(ACCOUNT_A, { next: "page-2-cursor" }));

    expect(repo.listCalls[0]?.page).toBe("page-2-cursor");
  });

  it("omits nextPage when the repository reports no further page (R5.1)", async () => {
    repo.seed(ACCOUNT_A, [score(1000)]);
    const handler = makePersonalHistoryHandler({ repository: repo });

    const result = await handler(authedEvent(ACCOUNT_A));
    const payload = JSON.parse(result.body) as Record<string, unknown>;

    expect("nextPage" in payload).toBe(false);
  });

  it("rejects a request with no authenticated account (401) and reads nothing (R5.3)", async () => {
    const handler = makePersonalHistoryHandler({ repository: repo });

    const result = await handler(authedEvent(null));

    expect(result.statusCode).toBe(401);
    expect(repo.listCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /scores/me/best
// ---------------------------------------------------------------------------

describe("GET /scores/me/best handler", () => {
  let repo: FakeScoreRepository;

  beforeEach(() => {
    repo = new FakeScoreRepository();
  });

  it("returns the caller's personal best for the scope, scoped to the JWT sub (R5.2, R11.2)", async () => {
    repo.seed(ACCOUNT_A, [score(3000), score(1500), score(2000)]);
    const handler = makePersonalBestHandler({ repository: repo });

    const result = await handler(authedEvent(ACCOUNT_A, mazeQuery(PARAMS)));
    const payload = JSON.parse(result.body) as { best: Score | null };

    expect(result.statusCode).toBe(200);
    expect(payload.best?.elapsedMs).toBe(1500);
    expect(repo.bestCalls).toEqual([{ accountId: ACCOUNT_A, params: PARAMS }]);
  });

  it("returns { best: null } when the caller has no entry for the scope (R5.2)", async () => {
    const handler = makePersonalBestHandler({ repository: repo });

    const result = await handler(authedEvent(ACCOUNT_A, mazeQuery(PARAMS)));
    const payload = JSON.parse(result.body) as { best: Score | null };

    expect(result.statusCode).toBe(200);
    expect(payload.best).toBeNull();
  });

  it("ignores a client-supplied accountId param when reading the personal best (R11.2)", async () => {
    repo.seed(ACCOUNT_A, [score(3000)]);
    repo.seed(ACCOUNT_B, [score(100)]);
    const handler = makePersonalBestHandler({ repository: repo });

    // Caller A adds an accountId param pointing at B's faster time. The lookup is
    // still scoped to A's JWT sub, so A sees only its own best.
    const result = await handler(
      authedEvent(ACCOUNT_A, { ...mazeQuery(PARAMS), accountId: ACCOUNT_B }),
    );
    const payload = JSON.parse(result.body) as { best: Score | null };

    expect(payload.best?.elapsedMs).toBe(3000);
    expect(repo.bestCalls[0]?.accountId).toBe(ACCOUNT_A);
  });

  it("never reveals another account's best (R5.3, R11.2)", async () => {
    // Only account B has a fast time for the scope; A must not see it.
    repo.seed(ACCOUNT_B, [score(100)]);
    const handler = makePersonalBestHandler({ repository: repo });

    const result = await handler(authedEvent(ACCOUNT_A, mazeQuery(PARAMS)));
    const payload = JSON.parse(result.body) as { best: Score | null };

    expect(payload.best).toBeNull();
    expect(repo.bestCalls[0]?.accountId).toBe(ACCOUNT_A);
  });

  it("rejects a missing/malformed maze scope (400) and reads nothing (R5.2)", async () => {
    const handler = makePersonalBestHandler({ repository: repo });

    const result = await handler(authedEvent(ACCOUNT_A, { rows: "6" })); // incomplete scope

    expect(result.statusCode).toBe(400);
    expect(repo.bestCalls).toHaveLength(0);
  });

  it("rejects a request with no authenticated account (401) and reads nothing (R5.3)", async () => {
    const handler = makePersonalBestHandler({ repository: repo });

    const result = await handler(authedEvent(null, mazeQuery(PARAMS)));

    expect(result.statusCode).toBe(401);
    expect(repo.bestCalls).toHaveLength(0);
  });
});
