// Client tick queues (the build/refresh poll loop).
//
// Shared verbatim between the browser (index.js imports this as a module) and
// the unit tests (pure_test.ts imports it under Deno), so what is tested is
// exactly what ships. Plain ESM on purpose: no TS syntax, because nothing
// transpiles this file — wrangler bundles it as a text module for serving and
// Deno runs it directly.
//
// Why the client owns these queues at all: Workers KV is eventually
// consistent, so a read right after a write can go stale for up to a minute.
// Asking the server "what is still pending?" on every tick used to see
// pre-write state, which kept the status line at "1 more model" and refetched
// the same model from CloudPrice ~10 times after ?refresh=1. The page hands
// the todo list over once; from then on the count only drops here, and only
// when the server says the head is done.

/**
 * @typedef {{ creators: string[], build: string[] }} TickQueues
 * @typedef {{ kind: "resolveCreator", id: string } | { kind: "next", id: string }} TickTarget
 * @typedef {{ handled?: unknown, retryAfterMs?: unknown } | null | undefined} TickReport
 */

// Rate-limit backoff floor; below this a 429 with a tiny retry-after would
// hammer the upstream on every tick.
const RETRY_FLOOR_MS = 10_000;

/**
 * What to spend the next tick on. Creators first: each is one cheap lookup,
 * so the Creator column settles before the slower benchmark crawl (the order
 * the server used to use).
 * @param {TickQueues} q
 * @returns {TickTarget | null}
 */
export function nextTickTarget(q) {
  const creator = q.creators[0];
  if (creator !== undefined) return { kind: "resolveCreator", id: creator };
  const next = q.build[0];
  if (next !== undefined) return { kind: "next", id: next };
  return null;
}

/**
 * Advance the queues after one tick response.
 *
 * `handled: true` pops the queue the target was taken from (see
 * nextTickTarget), so a response always pairs with the request the client
 * actually sent. Anything else — rate limit, transient error, malformed or
 * truncated body — keeps the head in place and returns a backoff delay
 * (null = the normal tick pace).
 *
 * @param {TickQueues} q
 * @param {TickReport} report
 * @returns {{ action: "retry", delayMs: number | null, queues: TickQueues, done: false } |
 *   { action: "pop", queue: "creators" | "build", queues: TickQueues, done: boolean }}
 */
export function advanceTick(q, report) {
  if (!report || report.handled !== true) {
    const retry = Number(report && report.retryAfterMs);
    return {
      action: "retry",
      delayMs: Number.isFinite(retry) && retry > 0
        ? Math.max(RETRY_FLOOR_MS, retry + 100)
        : null,
      queues: q,
      done: false,
    };
  }
  const fromCreators = q.creators.length > 0;
  const queue = fromCreators ? "creators" : "build";
  const creators = fromCreators ? q.creators.slice(1) : q.creators.slice();
  const build = fromCreators ? q.build.slice() : q.build.slice(1);
  const queues = { creators, build };
  return {
    action: "pop",
    queue,
    queues,
    done: creators.length === 0 && build.length === 0,
  };
}
