// Unit tests for pure.ts. Run with: deno task test  (or: deno test pure_test.ts)
// Dependency-free (no network) so they run offline in CI.

import {
  aaRankPercentile,
  cleanName,
  cleanReqCount,
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
