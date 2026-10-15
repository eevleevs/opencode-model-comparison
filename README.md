# OpenCode Go — Coding Model Value Leaderboard

Ranks the latest models on OpenCode Go by **value** = coding benchmark performance × utilization.

| Metric | Meaning |
| --- | --- |
| Benchmarks | Nine coding/agentic + knowledge benchmarks from CloudPrice (SciCode, CodInd, LCR, TermBench, TAU2, IFBench, IntInd, GPQA, HLE) |
| AggBench | Average CloudPrice percentile (0–100) across a model's available benchmarks — comparable across mixed 0–1 / 0–100 scales |
| Value | `AggBench / 100 × requests/month`, normalized so the best model scores 100 |
| Utilization | Requests per 5 hours / week / month from the OpenCode Go docs |

Sources: [opencode.ai/zen/go/models](https://opencode.ai/zen/go/v1/models), the [Go docs](https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/go.mdx), and [CloudPrice](https://ai.cloudprice.net/api/v1).

## Why the tick-based build?

The server never fetches more than **one** CloudPrice model per HTTP request:

- Each model's benchmark data is persisted to Workers KV the moment it's fetched (`["model", <id>]`).
- The page always renders immediately from whatever is in KV, no matter how many models remain.
- The client polls `GET /?tick=1` (one model per tick, ~2.5s cadence, respect `retry-after` on 429) until all models are resolved.
- Every successful tick returns the fetched model's data, so the table updates **live in place** without reloading; a single reload happens once `remaining` hits 0.
- Models with no public benchmarks (404/409) are stored as short-lived tombstones so ticks don't retry them, but they re-fetch after running out.

The design started on Deno Deploy (which killed requests that ran too long) and stays on Cloudflare Workers: it bounds per-request work, keeps every request inside free-tier limits, and lets the page render immediately from whatever is cached (stale-while-revalidate). Adding `?refresh=1` marks all cached models for revalidation and rebuilds one model per tick.

KV only ever holds a **rebuildable cache** — there is no data to migrate, and a fresh namespace simply rebuilds itself as visitors arrive.

## Deploying (Cloudflare Workers)

```sh
bun install                            # standard node_modules (npm install works too)
deno task deploy                       # = wrangler deploy; or `bun run deploy` with Node/Bun working
bunx wrangler kv namespace create KV   # once: paste the printed id into wrangler.jsonc
bunx wrangler secret put AA_API_KEY    # once: server-side secret; optional (CloudPrice-only fallback)
```

Toolchain notes: the scripts in `package.json` are plain npm scripts, so `npm install` / `npx wrangler` / `npm run deploy` are equivalent where Node is installed. On machines without Node, wrangler runs under Deno (`deno task dev` / `deno task deploy`). Running wrangler under Bun hangs on this machine (workerd never receives its config, so every request stalls) — install deps with Bun if you like, but launch wrangler via Deno or Node.

After the first deploy, attach your domain in the Workers dashboard (or add `routes` to `wrangler.jsonc`). Verify with `GET /?debug=1` (per-model cache status + AA coverage).

## Development

```sh
bun install
cp .dev.vars.example .dev.vars   # add your AA_API_KEY (optional)
deno task dev                    # wrangler dev — local workerd + simulated KV
```

Manual checks:

```sh
bun run check    # tsc --noEmit against Workers types
deno task test   # unit tests (pure.ts helpers, offline; runs under Deno)
```

## Repo layout

- `main.ts` — Workers fetch handler, Workers KV adapter, one-model tick endpoint, HTML render
- `pure.ts` / `pure_test.ts` — side-effect-free helpers + unit tests
- `index.html` / `index.js` / `index.css` — client, including the tick-polling + live-update loop (bundled as text modules via `wrangler.jsonc` `rules`)
- `wrangler.jsonc` — Workers config: entry point, KV binding, text-module rules
