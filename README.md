# OpenCode Go — Coding Model Value Leaderboard

Ranks the latest models on OpenCode Go by **value** = coding benchmark performance × utilization.

| Metric | Meaning |
| --- | --- |
| Benchmarks | Nine coding/agentic + knowledge benchmarks from CloudPrice (SciCode, CodInd, LCR, TermBench, TAU2, IFBench, IntInd, GPQA, HLE) |
| AggBench | Average CloudPrice percentile (0–100) across a model's available benchmarks — comparable across mixed 0–1 / 0–100 scales |
| Value | `AggBench / 100 × requests/month`, normalized so the best model scores 100 |
| Utilization | Requests per 5 hours / week / month from the OpenCode Go docs |

Sources: [opencode.ai/zen/go/models](https://opencode.ai/zen/go/v1/models), the [Go docs](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx), and [CloudPrice](https://ai.cloudprice.net/api/v1).

## Why the tick-based build?

Deno Deploy kills requests that run too long (`502 TIME_LIMIT`) and isolates shut down after idle. Fetching 35 models in one request used to 429 CloudPrice and die before persisting anything.

The server therefore never fetches more than **one** CloudPrice model per HTTP request:

- Each model's benchmark data is persisted to Deno KV the moment it's fetched (`["model", <id>]`).
- The page always renders immediately from whatever is in KV, no matter how many models remain.
- The client polls `GET /?tick=1` (one model per tick, ~2.5s cadence, respect `retry-after` on 429) until all models are resolved.
- Every successful tick returns the fetched model's data, so the table updates **live in place** without reloading; a single reload happens once `remaining` hits 0.
- Models with no public benchmarks (404/409) are stored as short-lived tombstones so ticks don't retry them, but they re-fetch after running out.

Adding `?refresh=1` wipes the model cache and rebuilds. Deploying is a single Deno Deploy project — KV persists automatically there.

## Development

```sh
deno task dev        # watch mode (recommended)
deno task start      # single run
```

Manual checks:

```sh
deno task test     # unit tests (pure.ts helpers, offline)
deno check --quiet main.ts
deno lint main.ts index.js
```

## Repo layout

- `main.ts` — Deno KV store, one-model tick endpoint, HTML handler
- `pure.ts` / `pure_test.ts` — side-effect-free helpers + unit tests
- `index.html` / `index.js` / `index.css` — client, including the tick-polling + live-update loop