/**
 * Deterministic seeded RNG for the composition root (task 10.3).
 *
 * The platform score path is an anti-cheat replay: the client submits the maze
 * *parameters* (including a `seed`) and its move sequence, and the server
 * rebuilds the maze from those parameters with its own seeded generator and
 * replays the moves (see `src/core/validateSubmission.ts`). For the server to
 * rebuild the *identical* maze the player actually played, the client must
 * generate its maze with the **same** seeded algorithm the server uses.
 *
 * `src/core/validateSubmission.ts` seeds its rebuild with a private `mulberry32`
 * PRNG. This module is the client-side counterpart, kept byte-for-byte
 * identical so that, given the same integer seed, the client and server draw
 * the same sequence and `RecursiveBacktrackerGenerator` carves the same maze
 * (design "Determinism"). It lives in the impure edges layer — the composition
 * root injects it into the pure core as the `rng: () => number` port — so the
 * core still never reaches for randomness itself and stays unchanged.
 *
 * It is a tiny, self-contained function (no I/O, no `Math.random`); duplicating
 * it here rather than exporting the core's private copy keeps the core's public
 * surface unchanged, which task 10.3 must not touch.
 */

/**
 * Build a deterministic PRNG (mulberry32). Given the same 32-bit integer seed
 * it yields the same sequence of numbers in `[0, 1)`, matching the seeded rng
 * `validateSubmission` uses to rebuild a submitted maze — so a maze the client
 * generates from `seed` is the exact maze the server rebuilds from the same
 * `seed`.
 *
 * @param seed - the integer seed identifying the maze (from `MazeParams.seed`).
 * @returns an `rng: () => number` suitable to inject into `DefaultMazeFactory`.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
