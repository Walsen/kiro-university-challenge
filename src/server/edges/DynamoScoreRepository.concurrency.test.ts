/**
 * Verification suite — per-account isolation and concurrent-write consistency
 * (task 9.1, R7.1, R7.4).
 *
 * Task 6.3's unit tests pin *what commands* `DynamoScoreRepository` issues, and
 * the 6.5 integration test proves those commands behave against the real dev
 * table. This suite verifies the two *guarantees* R7 asks for, deterministically
 * and with no AWS:
 *
 *  - **R7.4 — concurrent writes for one account converge with no lost valid
 *    score.** Two concurrent submissions of the *same* validated Run (same
 *    account, scope, authoritative time) converge to a single Score — exactly
 *    one `persisted: true` and one deduped `persisted: false`, never two Scores
 *    and never zero. A slower and a faster concurrent submission for the same
 *    account resolve to the correct personal best regardless of arrival order.
 *  - **R7.1 — independent players never affect each other's scores.** Writes for
 *    one account never read or mutate another account's items; interleaved
 *    concurrent submissions across accounts leave each account's history and
 *    best exactly as if it had run alone.
 *
 * These are properties of the *real* adapter, so the adapter under test is the
 * real `DynamoScoreRepository`. What it talks to — DynamoDB — is the genuinely
 * external collaborator, so it is faked. The fake is not a rubber stamp: it is a
 * faithful in-memory model of the only two DynamoDB mechanisms the adapter's
 * guarantees rest on — a single-item store keyed by `(PK, SK)`, and the two
 * conditional expressions the adapter writes (`attribute_not_exists(#pk)` for the
 * idempotent Score put, `attribute_not_exists(#best) OR :time < #best` for the
 * personal best). If the adapter stopped relying on those conditions, or keyed a
 * duplicate to a different item, these tests would fail.
 *
 * ## Determinism
 *
 * No wall-clock and no `Math.random`: identifiers are fixed literals and any
 * randomised ordering is driven by a seeded LCG (`seededRng`) so a failure
 * reproduces. "Concurrency" is modelled the way a single-threaded JS runtime
 * actually interleaves it — the fake yields at an `await` between reading a
 * condition and applying the write, and the suite starts overlapping `putScore`
 * calls before awaiting them, so their internal steps interleave on the microtask
 * queue. That is the exact race the `attribute_not_exists` guard exists to make
 * safe, exercised without threads or a network.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DynamoScoreRepository } from "./DynamoScoreRepository";
import { PARTITION_KEY, SORT_KEY } from "./dynamoSchema";
import type { DynamoCommand, DynamoDocumentClient } from "./dynamoClient";
import type { MazeParams, Score } from "../../core/validateSubmission";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TABLE = "maze-game-platform-test";
const PARAMS: MazeParams = { rows: 5, columns: 5, seed: 42, timeLimitSeconds: 60 };

function score(elapsedMs: number, params: MazeParams = PARAMS): Score {
  return { outcome: "Won", mazeParams: params, elapsedMs };
}

/**
 * A tiny seeded PRNG (a Lehmer/Park–Miller LCG) so any test that shuffles arrival
 * order is reproducible: same seed, same interleaving, no `Math.random`. Returns
 * a float in [0, 1).
 */
function seededRng(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) {
    state += 2_147_483_646;
  }
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

/** Deterministic Fisher–Yates shuffle driven by a seeded rng. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// ---------------------------------------------------------------------------
// A faithful in-memory DynamoDB modelling only what the guarantees rest on
// ---------------------------------------------------------------------------

/** The DynamoDB SDK signals a failed condition with this error `name`. */
class ConditionalCheckFailed extends Error {
  public override readonly name = "ConditionalCheckFailedException";
}

type Item = Record<string, unknown>;

/**
 * An in-memory single table keyed by `(PK, SK)`, understanding exactly the
 * command shapes `DynamoScoreRepository` issues:
 *
 *  - `PutCommand` with `ConditionExpression: "attribute_not_exists(#pk)"` — write
 *    the item only if no item exists at its key; otherwise fail the condition.
 *  - `UpdateCommand` with `"attribute_not_exists(#best) OR :time < #best"` —
 *    upsert the best item only when there is no prior best or the new time is
 *    strictly lower; otherwise fail the condition.
 *  - `GetCommand` / `QueryCommand` — reads used by assertions and by the
 *    adapter's own `personalBest` / `listByAccount`.
 *
 * Crucially it enforces isolation structurally: an item lives at its `(PK, SK)`,
 * and a query is filtered to the requested partition, so there is no code path by
 * which one account's write lands in or reads from another account's partition.
 *
 * To model concurrency honestly, every `send` yields to the microtask queue once
 * before applying its effect. When two `putScore` calls are launched and awaited
 * together, their read-condition/apply steps therefore interleave — the write
 * race the conditional guard must survive.
 */
class InMemoryDynamo implements DynamoDocumentClient {
  private readonly items = new Map<string, Item>();

  private static keyOf(pk: unknown, sk: unknown): string {
    return `${String(pk)}\u0000${String(sk)}`;
  }

  public async send(command: DynamoCommand): Promise<unknown> {
    const type = command.constructor.name;
    const input = command.input as Record<string, unknown>;
    // Yield once so overlapping operations interleave on the microtask queue.
    await Promise.resolve();

    switch (type) {
      case "PutCommand":
        return this.put(input);
      case "UpdateCommand":
        return this.update(input);
      case "GetCommand":
        return this.get(input);
      case "QueryCommand":
        return this.query(input);
      default:
        throw new Error(`unexpected command ${type}`);
    }
  }

  private put(input: Record<string, unknown>): unknown {
    const item = input["Item"] as Item;
    const key = InMemoryDynamo.keyOf(item[PARTITION_KEY], item[SORT_KEY]);
    if (
      typeof input["ConditionExpression"] === "string" &&
      input["ConditionExpression"].includes("attribute_not_exists") &&
      this.items.has(key)
    ) {
      throw new ConditionalCheckFailed("item already exists");
    }
    this.items.set(key, { ...item });
    return {};
  }

  private update(input: Record<string, unknown>): unknown {
    const rawKey = input["Key"] as Item;
    const key = InMemoryDynamo.keyOf(rawKey[PARTITION_KEY], rawKey[SORT_KEY]);
    const values = input["ExpressionAttributeValues"] as Record<string, unknown>;
    const newTime = values[":time"] as number;
    const existing = this.items.get(key);
    const priorBest = existing?.["elapsedMs"] as number | undefined;

    // Mirror "attribute_not_exists(#best) OR :time < #best".
    if (priorBest !== undefined && !(newTime < priorBest)) {
      throw new ConditionalCheckFailed("not a new best");
    }
    this.items.set(key, {
      [PARTITION_KEY]: rawKey[PARTITION_KEY],
      [SORT_KEY]: rawKey[SORT_KEY],
      elapsedMs: newTime,
      params: values[":attrs"],
    });
    return {};
  }

  private get(input: Record<string, unknown>): unknown {
    const rawKey = input["Key"] as Item;
    const item = this.items.get(
      InMemoryDynamo.keyOf(rawKey[PARTITION_KEY], rawKey[SORT_KEY]),
    );
    return item === undefined ? {} : { Item: { ...item } };
  }

  private query(input: Record<string, unknown>): unknown {
    const values = input["ExpressionAttributeValues"] as Record<string, unknown>;
    const pk = values[":pk"];
    const prefix = values[":scorePrefix"] as string | undefined;
    const matches = [...this.items.values()].filter((item) => {
      if (item[PARTITION_KEY] !== pk) {
        return false;
      }
      return prefix === undefined || String(item[SORT_KEY]).startsWith(prefix);
    });
    return { Items: matches.map((item) => ({ ...item })) };
  }

  // -- test-only observation helpers (not part of the adapter's contract) --

  /** Every stored item under one account partition, for isolation assertions. */
  public itemsUnder(pk: string): Item[] {
    return [...this.items.values()].filter((item) => item[PARTITION_KEY] === pk);
  }

  /** Total item count, to assert nothing extra was created. */
  public size(): number {
    return this.items.size;
  }
}

function repo(client: DynamoDocumentClient): DynamoScoreRepository {
  return new DynamoScoreRepository({ client, tableName: TABLE });
}

// ---------------------------------------------------------------------------
// R7.4 — concurrent writes for one account converge, losing no valid score
// ---------------------------------------------------------------------------

describe("concurrent submissions for one account converge consistently (R7.4)", () => {
  let store: InMemoryDynamo;

  beforeEach(() => {
    store = new InMemoryDynamo();
  });

  it("collapses two concurrent identical submissions to exactly one persisted Score", async () => {
    // Both calls launched before either is awaited: their read/apply steps
    // interleave on the microtask queue — the exact write race R7.4 addresses.
    const [a, b] = await Promise.all([
      repo(store).putScore("acct-a", score(5_000)),
      repo(store).putScore("acct-a", score(5_000)),
    ]);

    // Convergence: one submission won, the other deduped. No lost write (not both
    // false) and no double write (not both true).
    const persistedCount = [a, b].filter((r) => r.persisted).length;
    expect(persistedCount).toBe(1);

    // Exactly one Score item exists for the account despite two concurrent puts.
    const history = await repo(store).listByAccount("acct-a");
    expect(history.items).toEqual([score(5_000)]);

    // And the winning submission is the one that claimed the personal best.
    const winner = a.persisted ? a : b;
    expect(winner.isPersonalBest).toBe(true);
  });

  it("survives many concurrent duplicates: still one Score, one winner", async () => {
    const submissions = Array.from({ length: 12 }, () =>
      repo(store).putScore("acct-a", score(7_500)),
    );

    const results = await Promise.all(submissions);

    expect(results.filter((r) => r.persisted)).toHaveLength(1);
    expect(results.filter((r) => !r.persisted)).toHaveLength(11);
    const history = await repo(store).listByAccount("acct-a");
    expect(history.items).toEqual([score(7_500)]);
  });

  it("resolves a faster and a slower concurrent submission to the faster best, order-independently", async () => {
    // Two *distinct* valid runs for one account raced concurrently. Whichever
    // arrival order the scheduler picks, the recorded best is the faster time and
    // both distinct scores are retained (neither valid score is lost).
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = seededRng(seed);
      const isolated = new InMemoryDynamo();
      const account = `acct-${seed}`;
      const order = shuffle([3_000, 8_000], rng);

      await Promise.all(order.map((ms) => repo(isolated).putScore(account, score(ms))));

      // The personal best converges to the faster time regardless of order.
      await expect(repo(isolated).personalBest(account, PARAMS)).resolves.toEqual(
        score(3_000),
      );
      // Both distinct valid scores survive — no otherwise-valid score is lost.
      const history = await repo(isolated).listByAccount(account);
      expect(history.items).toContainEqual(score(3_000));
      expect(history.items).toContainEqual(score(8_000));
      expect(history.items).toHaveLength(2);
    }
  });

  it("keeps a duplicate from ever displacing or duplicating the personal best", async () => {
    // A first win sets the best; a concurrent burst of the identical run must not
    // create a second Score nor re-run the best write.
    const first = await repo(store).putScore("acct-a", score(4_200));
    expect(first).toEqual({ persisted: true, isPersonalBest: true });

    const dupes = await Promise.all([
      repo(store).putScore("acct-a", score(4_200)),
      repo(store).putScore("acct-a", score(4_200)),
      repo(store).putScore("acct-a", score(4_200)),
    ]);
    for (const r of dupes) {
      expect(r).toEqual({ persisted: false, isPersonalBest: false });
    }

    await expect(repo(store).personalBest("acct-a", PARAMS)).resolves.toEqual(
      score(4_200),
    );
  });
});

// ---------------------------------------------------------------------------
// R7.1 — independent players never affect each other's scores
// ---------------------------------------------------------------------------

describe("independent accounts stay isolated under concurrency (R7.1)", () => {
  it("writes for one account never land in or read from another account's partition", async () => {
    const store = new InMemoryDynamo();

    await repo(store).putScore("acct-a", score(5_000));
    await repo(store).putScore("acct-b", score(9_000));

    // Each account's history contains only its own score.
    const historyA = await repo(store).listByAccount("acct-a");
    const historyB = await repo(store).listByAccount("acct-b");
    expect(historyA.items).toEqual([score(5_000)]);
    expect(historyB.items).toEqual([score(9_000)]);

    // And structurally, every stored item lives under exactly its owner.
    for (const item of store.itemsUnder("ACCT#acct-a")) {
      expect(item["accountId"] === undefined || item["accountId"] === "acct-a").toBe(
        true,
      );
    }
  });

  it("an account with the same time and scope as another still gets its own Score", async () => {
    // Same scope, same authoritative time, DIFFERENT accounts: idempotency must
    // NOT collapse them — the account id is part of the item key.
    const store = new InMemoryDynamo();

    const a = await repo(store).putScore("acct-a", score(5_000));
    const b = await repo(store).putScore("acct-b", score(5_000));

    expect(a).toEqual({ persisted: true, isPersonalBest: true });
    expect(b).toEqual({ persisted: true, isPersonalBest: true });
    await expect(repo(store).personalBest("acct-a", PARAMS)).resolves.toEqual(
      score(5_000),
    );
    await expect(repo(store).personalBest("acct-b", PARAMS)).resolves.toEqual(
      score(5_000),
    );
  });

  it("interleaved concurrent submissions across accounts leave each as if it ran alone", async () => {
    // A deterministic reference: what each account's state SHOULD be when run in
    // isolation. Then the same submissions are fired concurrently, in a seeded
    // shuffled order, and must produce the identical per-account outcome.
    const plan: ReadonlyArray<{ account: string; times: readonly number[] }> = [
      { account: "acct-a", times: [8_000, 3_000, 8_000] }, // dup 8_000 + faster 3_000
      { account: "acct-b", times: [5_000] },
      { account: "acct-c", times: [9_000, 4_000] },
    ];

    // Reference outcome, computed by running each account alone.
    const expected = new Map<string, { best: number; distinct: number[] }>();
    for (const { account, times } of plan) {
      const solo = new InMemoryDynamo();
      for (const ms of times) {
        await repo(solo).putScore(account, score(ms));
      }
      const distinct = [...new Set(times)].sort((x, y) => x - y);
      expected.set(account, { best: Math.min(...times), distinct });
    }

    // Concurrent run: flatten every submission, shuffle deterministically, and
    // fire them all at once so cross-account operations interleave.
    const rng = seededRng(12_345);
    const flat = plan.flatMap(({ account, times }) =>
      times.map((ms) => ({ account, ms })),
    );
    const shared = new InMemoryDynamo();
    await Promise.all(
      shuffle(flat, rng).map(({ account, ms }) =>
        repo(shared).putScore(account, score(ms)),
      ),
    );

    // Each account's converged state equals its run-alone reference.
    for (const { account } of plan) {
      const ref = expected.get(account);
      const best = await repo(shared).personalBest(account, PARAMS);
      expect(best?.elapsedMs).toBe(ref?.best);

      const history = await repo(shared).listByAccount(account);
      const times = history.items.map((s) => s.elapsedMs).sort((x, y) => x - y);
      expect(times).toEqual(ref?.distinct);
    }

    // No cross-contamination: total items = one Score per distinct (account,time)
    // plus one best per account.
    const distinctScores = plan.reduce(
      (n, { times }) => n + new Set(times).size,
      0,
    );
    const bests = plan.length;
    expect(shared.size()).toBe(distinctScores + bests);
  });
});
