// Unit tests for pure.ts. Run with: deno task test  (or: deno test pure_test.ts)
// Dependency-free (no network) so they run offline in CI.

import {
  aaRankPercentile,
  cleanName,
  cleanReqCount,
  collapseCreator,
  creatorCandidates,
  creatorFamily,
  findTable,
  findTables,
  knownCreator,
  parseMarkdownTables,
  pendingCreatorModels,
  rankPercentile,
} from "./pure.ts";

function assertEquals<T>(actual: T, expected: T, msg: string): void {
  const a = typeof actual === "number" && isNaN(actual) ? "NaN" : actual;
  const e = typeof expected === "number" && isNaN(expected) ? "NaN" : expected;
  if (a !== e) {
    throw new Error(`${msg}: got ${a}, expected ${e}`);
  }
}

function assertClose(
  actual: number,
  expected: number,
  msg: string,
  tol = 0.25,
): void {
  if (isNaN(expected)) {
    if (!isNaN(actual)) throw new Error(`${msg}: got ${actual}, expected NaN`);
    return;
  }
  if (Math.abs(actual - expected) >= tol) {
    throw new Error(`${msg}: got ${actual}, expected ~${expected}`);
  }
}

Deno.test("cleanReqCount takes the last number, strips promo markup", () => {
  const cases: Array<[string | undefined, number]> = [
    ["6,320", 6320],
    ["~~6,500~~<br />**26,000**", 26000],
    ["**26,000**", 26000],
    ["~~16,250~~<br />**65,000**", 65000],
    ["4,300", 4300],
    // "Unlimited" is a real state (non-metered model), not a parse failure.
    // NaN still means "could not read this cell".
    ["Unlimited", Infinity],
    ["unlimited", Infinity],
    ["**Unlimited**", Infinity],
    ["—", NaN],
    ["-", NaN],
    [undefined, NaN],
  ];
  for (const [input, expected] of cases) {
    assertEquals(cleanReqCount(input), expected, JSON.stringify(input));
  }
});

Deno.test("cleanName drops <small> promo blocks for the limits join", () => {
  const cases: Array<[string | undefined, string]> = [
    ["DeepSeek V4.1 Flash<br /><small>4x · Ends Sep 20</small>", "DeepSeek V4.1 Flash"],
    ["DeepSeek V4.1 Flash", "DeepSeek V4.1 Flash"],
    ["**Grok 4.6**", "Grok 4.6"],
    ["Kimi K3", "Kimi K3"],
    ["", ""],
    [undefined, ""],
  ];
  for (const [input, expected] of cases) {
    assertEquals(cleanName(input), expected, JSON.stringify(input));
  }
});

Deno.test("rankPercentile: rank 1 -> 100, last -> 0", () => {
  const cases: Array<[number, number, number]> = [
    [1, 536, 100],
    [536, 536, 0],
    // Real upstream sample: kimi-k3 GPQA rank 11/536 -> 98.1, matching
    // CloudPrice's own precalculated percentile.
    [11, 536, 98.1],
    [33, 536, 94],
    [1, 1, NaN],
    [1, 0, NaN],
    [NaN, 100, NaN],
    // Out-of-range clamps instead of overshooting.
    [5, 2, 0],
  ];
  for (const [rank, total, expected] of cases) {
    assertClose(rankPercentile(rank, total), expected, `rank=${rank}/${total}`);
  }
});

Deno.test("creatorFamily groups by first word, knownCreator honours precedence", () => {
  assertEquals(creatorFamily("longcat-2.0"), "longcat", "longcat family");
  assertEquals(
    creatorFamily("longcat-2.5-preview-free"),
    "longcat",
    "sibling shares the family",
  );
  // hy3 and hy4-preview are different families: nothing crosses over.
  assertEquals(creatorFamily("hy3"), "hy3", "hy3 family");
  assertEquals(creatorFamily("hy4-preview"), "hy4", "hy4 family");
  assertEquals(creatorFamily("qwen3.8-max"), "qwen3", "dotted id");
  assertEquals(creatorFamily(""), "", "empty id");

  const creators = { "longcat-2.0": "longcat" };
  const families = { longcat: "longcat" };

  // AA's per-model slug wins over everything.
  assertEquals(
    knownCreator("longcat-2.0", "longcat", creators, families),
    "longcat",
    "aa slug",
  );
  assertEquals(
    knownCreator("longcat-2.0", "aa-wins", creators, families),
    "aa-wins",
    "aa slug beats the memo",
  );
  // A sibling with no answer of its own reuses the family hint. This is the
  // whole point of the family map: longcat-2.5-preview-free 404s upstream, but
  // longcat-2.0's real answer identifies the family.
  assertEquals(
    knownCreator("longcat-2.5-preview-free", undefined, creators, families),
    "longcat",
    "family hint",
  );
  // Nothing known anywhere: empty, never invented.
  assertEquals(
    knownCreator("omen-alpha", undefined, {}, {}),
    "",
    "unknown stays empty",
  );
  // An empty memo must not shadow the family hint.
  assertEquals(
    knownCreator(
      "longcat-2.5-preview-free",
      undefined,
      { "longcat-2.5-preview-free": "" },
      families,
    ),
    "longcat",
    "empty memo does not shadow the family",
  );
});

Deno.test("pendingCreatorModels counts only work that still needs doing", () => {
  const goIds = [
    "grok-4.7",
    "hy3",
    "hy4-preview",
    "omen-alpha",
    "muse-spark-1.2-contributor",
    "longcat-2.5-preview-free",
  ];

  // Nothing known yet: every model needs its own lookup.
  assertEquals(
    pendingCreatorModels(goIds, {}, {}, {}).join(","),
    goIds.join(","),
    "all pending when nothing is known",
  );

  const creators = {
    "grok-4.7": "xai",
    "hy3": "tencent",
    "hy4-preview": "",
    "omen-alpha": "",
  };
  const families = { grok: "xai", hy3: "tencent" };
  const retried = { "omen-alpha": 1 };
  // hy4-preview is empty with its retry unspent; muse-spark was never
  // attempted. grok-4.7 and hy3 are resolved, omen-alpha is terminal.
  assertEquals(
    pendingCreatorModels(goIds, creators, families, retried).join(","),
    "hy4-preview,muse-spark-1.2-contributor,longcat-2.5-preview-free",
    "only unanswerable models are pending",
  );

  // A family hint settles a model with no answer of its own, and that model
  // stops costing a request.
  assertEquals(
    pendingCreatorModels(goIds, creators, {
      ...families,
      longcat: "longcat",
    }, retried).join(","),
    "hy4-preview,muse-spark-1.2-contributor",
    "family-answered model is not pending",
  );

  // Spending the retry makes a model terminal, which is what stops the client
  // poll loop spinning forever on a model CloudPrice will never resolve.
  assertEquals(
    pendingCreatorModels(
      goIds,
      {
        ...creators,
        "hy4-preview": "",
        "muse-spark-1.2-contributor": "",
        "longcat-2.5-preview-free": "",
      },
      families,
      {
        ...retried,
        "hy4-preview": 1,
        "muse-spark-1.2-contributor": 1,
        "longcat-2.5-preview-free": 1,
      },
    ).length,
    0,
    "retry spent means nothing pending",
  );
});

Deno.test("collapseCreator folds variants, bails on cross-slug and multi-vendor", () => {
  // A 409 is usually one model under several variants; that collapses for free.
  assertEquals(
    collapseCreator(["minimax", "minimax", "minimax", "minimax"]),
    "minimax",
    "minimax-m2.7 variants",
  );
  assertEquals(collapseCreator(["xai", "xai"]), "xai", "grok candidates");
  assertEquals(collapseCreator(["xiaomi", "xiaomi"]), "xiaomi", "mimo vendors");

  // The same vendor under two slugs (z-ai / zhipu) is NOT folded: there is no
  // alias map, so it takes the exact-candidate retry instead. Accepted, since
  // the column is informational and the retry resolves either way.
  assertEquals(
    collapseCreator(["z-ai", "zhipu", "zhipu"]),
    null,
    "cross-slug is ambiguous, retried by exact id",
  );
  assertEquals(collapseCreator(["xai", "openai"]), null, "two real vendors");
  assertEquals(collapseCreator([]), null, "no candidates");
  assertEquals(collapseCreator([""]), null, "blank candidates");
});

Deno.test("creatorCandidates parses real CloudPrice 409 bodies", () => {
  // Captured verbatim from GET /models/{id} for mimo-v2.6-pro.
  const mimo = {
    error: {
      code: "multiple_matches",
      message: "ID matches multiple models",
      details: {
        candidates: [
          {
            id: "xiaomi-mimo-2-6-pro",
            display_name: "MiMo V2.6 Pro",
            match_type: "fuzzy",
          },
          {
            id: "xiaomi-mimo-2-6-pro-ultraspeed",
            display_name: "MiMo V2.6 Pro UltraSpeed",
            match_type: "fuzzy",
          },
        ],
      },
    },
    meta: { request_id: "39abbf9f-e64e-43b0-99f0-d6d5439af21c" },
  };
  const cands = creatorCandidates(mimo);
  assertEquals(cands.length, 2, "mimo candidate count");
  assertEquals(cands[0], "xiaomi-mimo-2-6-pro", "mimo first candidate");
  assertEquals(collapseCreator(["xiaomi", "xiaomi"]), "xiaomi", "mimo vendors");

  // glm-5.3-flash: the same vendor under two slugs. Without an alias map this
  // does not collapse, so the caller retries the exact candidate id instead
  // ("z-ai-glm-5-3-flash"), which returns a single unambiguous creator.
  const glm = {
    error: {
      code: "multiple_matches",
      details: {
        candidates: [
          { id: "z-ai-glm-5-3-flash" },
          { id: "zhipu-glm-5-3-flash" },
          { id: "zhipu-glm-5-3-flash-x" },
        ],
      },
    },
  };
  assertEquals(creatorCandidates(glm).length, 3, "glm candidate count");
  assertEquals(
    collapseCreator(["z-ai", "zhipu", "zhipu"]),
    null,
    "cross-slug defers to the exact-id retry",
  );
  assertEquals(
    creatorCandidates(glm)[0],
    "z-ai-glm-5-3-flash",
    "retry target is the first candidate",
  );

  // minimax-m2.7: four same-vendor variants, which do collapse.
  assertEquals(
    collapseCreator(["minimax", "minimax", "minimax", "minimax"]),
    "minimax",
    "minimax variants",
  );

  // Defensive shapes: never throw on a body we did not expect.
  assertEquals(creatorCandidates(null).length, 0, "null body");
  assertEquals(creatorCandidates({}).length, 0, "empty body");
  assertEquals(
    creatorCandidates({ error: { code: "not_found" } }).length,
    0,
    "no details",
  );
  assertEquals(
    creatorCandidates({ error: { details: { candidates: [{}, null] } } })
      .length,
    0,
    "candidates without ids",
  );
});

Deno.test("findTable matches docs headers case-insensitively", () => {
  // Real shape from the Go docs, with the current capitalization. The header
  // used to be lowercase "requests per 5 hours"; a case-sensitive match made
  // that cosmetic re-capitalization empty the entire limits column.
  const mdx = [
    "Some prose.",
    "",
    "| Model                        | Model ID     | Endpoint                 |",
    "| ---------------------------- | ------------ | ------------------------ |",
    "| MiMo-V2.6-Flash              | mimo-v2.6-flash | `https://x/v1/chat` |",
    "| Grok 4.7                     | grok-4.7     | `https://x/v1/responses`  |",
    "",
    "| Model                        | Requests per 5 hours | Requests per week | Requests per month |",
    "| ---------------------------- | -------------------- | ----------------- | ------------------ |",
    "| MiMo-V2.6-Flash              | 30,100               | 75,200            | 150,400            |",
    "| Grok 4.7                     | 169                  | 423               | 845                |",
  ].join("\n");

  const tables = parseMarkdownTables(mdx);
  const endpoints = findTable(tables, "Model ID");
  const requests = findTable(tables, "requests per 5 hour");
  if (!endpoints || !requests) {
    throw new Error("expected both tables to be found case-insensitively");
  }
  assertEquals(endpoints.rows.length, 2, "endpoints row count");
  assertEquals(requests.rows.length, 2, "requests row count");
  assertEquals(
    endpoints.rows[0][1],
    "mimo-v2.6-flash",
    "display name -> id join",
  );
  assertEquals(cleanReqCount(requests.rows[0][3]), 150400, "req/month");

  // A genuinely absent header must still miss rather than match something.
  if (findTable(tables, "No Such Column") !== null) {
    throw new Error("expected null for a missing header");
  }
});

Deno.test("findTables keeps both per-plan limits tables", () => {
  // The docs publish the same table twice, once per plan, with byte-identical
  // headers. Deduplicating by header would silently drop a plan and inflate
  // or deflate every Value, so both must survive, in document order.
  const header =
    "| Model           | Requests per 5 hours | Requests per week | Requests per month |";
  const sep =
    "| --------------- | -------------------- | ----------------- | ------------------ |";
  const mdx = [
    header,
    sep,
    "| Kimi K3         | 110                  | 250               | 490                |",
    "",
    header,
    sep,
    "| Kimi K3         | 440                  | 1,000             | 1,960              |",
  ].join("\n");

  const tables = parseMarkdownTables(mdx);
  const requests = findTables(tables, "requests per 5 hour");
  assertEquals(requests.length, 2, "both per-plan tables kept");
  assertEquals(cleanReqCount(requests[0].rows[0][3]), 490, "Go plan");
  assertEquals(cleanReqCount(requests[1].rows[0][3]), 1960, "Go Plus plan");
  // findTable still resolves to the first, which is the Go plan.
  assertEquals(
    cleanReqCount(findTable(tables, "requests per 5 hour")!.rows[0][3]),
    490,
    "findTable takes the first match",
  );
});

Deno.test("aaRankPercentile: min -> 0, median -> 50, max -> 100", () => {
  const cases: Array<[number[], number, number]> = [
    [[1, 2, 3, 4, 5], 1, 0],
    [[1, 2, 3, 4, 5], 3, 50],
    [[1, 2, 3, 4, 5], 5, 100],
    [[1, 2, 3, 4, 5], 4, 75],
    [[1, 2, 3, 4, 5], 0, 0],
    [[1, 2, 3, 4, 5], 9, 100],
    [[7], 7, 50],
    [[0.5, 0.7, 0.9], 0.7, 50],
  ];
  for (const [dist, value, expected] of cases) {
    assertEquals(aaRankPercentile(dist, value), expected, `v=${value}`);
  }
});
