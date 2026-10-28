import { describe, expect, it } from "vitest";

import {
  createBm25SearchIndex,
  searchBm25,
  tokenizeBm25Text,
} from "./bm25-search.js";

describe("tokenizeBm25Text", () => {
  it("splits camelCase and lowercases tokens", () => {
    expect(tokenizeBm25Text("searchToolFunctions JSON_v2")).toEqual([
      "search",
      "tool",
      "functions",
      "json",
      "v2",
    ]);
  });

  it("splits consecutive uppercase sequences (acronyms)", () => {
    expect(tokenizeBm25Text("getHTTPStatus")).toEqual([
      "get",
      "http",
      "status",
    ]);
    expect(tokenizeBm25Text("parseURLQuery")).toEqual([
      "parse",
      "url",
      "query",
    ]);
  });
});

describe("searchBm25", () => {
  const documents = [
    { document: { id: "slack" }, text: "Slack message search channels" },
    { document: { id: "linear" }, text: "Linear issue search roadmap" },
    { document: { id: "github" }, text: "GitHub code search repository" },
    { document: { id: "calendar" }, text: "Calendar event lookup" },
  ];

  it("returns matching documents sorted by BM25 score", () => {
    const index = createBm25SearchIndex(documents);

    expect(searchBm25(index, { query: "slack message search" })).toEqual([
      {
        document: { id: "slack" },
        score: expect.any(Number),
      },
      {
        document: { id: "linear" },
        score: expect.any(Number),
      },
      {
        document: { id: "github" },
        score: expect.any(Number),
      },
    ]);
  });

  it("limits results after scoring", () => {
    const index = createBm25SearchIndex(documents);

    expect(searchBm25(index, { query: "search", limit: 2 })).toHaveLength(2);
  });

  it("supports weighted fields without repeating text", () => {
    const index = createBm25SearchIndex([
      {
        document: { id: "weighted" },
        fields: [{ text: "priority", weight: 3 }],
      },
      {
        document: { id: "plain" },
        fields: [{ text: "priority" }],
      },
    ]);

    const results = searchBm25(index, { query: "priority" });

    expect(results.map((result) => result.document.id)).toEqual([
      "weighted",
      "plain",
    ]);

    // weight=3 should give exactly 3× the score of weight=1 since both
    // documents are otherwise identical (same raw TF, same length)
    const weightedScore = results[0]?.score ?? 0;
    const plainScore = results[1]?.score ?? 0;
    expect(weightedScore / plainScore).toBeCloseTo(3, 5);
  });

  it("field weight gives proportional score boost, not diminished by TF saturation", () => {
    // Previously, weight was added to term frequency rather than applied as a
    // multiplier after BM25 scoring. BM25's saturation curve (TF*(k1+1)/(TF+norm))
    // has diminishing returns, so weight=5 on a single token produced only ~1.8×
    // boost instead of 5×. Weights are now multiplied onto the final posting score.
    const index = createBm25SearchIndex([
      { document: { id: "w5" }, fields: [{ text: "match", weight: 5 }] },
      { document: { id: "w2" }, fields: [{ text: "match", weight: 2 }] },
      { document: { id: "w1" }, fields: [{ text: "match" }] },
    ]);

    const results = searchBm25(index, { query: "match" });
    const byId = Object.fromEntries(
      results.map((r) => [r.document.id, r.score]),
    );

    expect(byId.w5! / byId.w1!).toBeCloseTo(5, 5);
    expect(byId.w2! / byId.w1!).toBeCloseTo(2, 5);
  });

  it("uses caller tie-breaking when scores match", () => {
    const index = createBm25SearchIndex([
      { document: { id: "b" }, text: "same" },
      { document: { id: "a" }, text: "same" },
    ]);

    expect(
      searchBm25(index, {
        query: "same",
        compareDocuments: (left, right) => left.id.localeCompare(right.id),
      }).map((result) => result.document.id),
    ).toEqual(["a", "b"]);
  });

  it("returns no results for empty corpora, empty queries, or unmatched terms", () => {
    expect(
      searchBm25(createBm25SearchIndex([]), { query: "anything" }),
    ).toEqual([]);

    const index = createBm25SearchIndex(documents);

    expect(searchBm25(index, { query: "" })).toEqual([]);
    expect(searchBm25(index, { query: "banana" })).toEqual([]);
    expect(searchBm25(index, { query: "search", limit: 0 })).toEqual([]);
  });

  it("returns only the top result when limit = 1", () => {
    const index = createBm25SearchIndex(documents);
    const results = searchBm25(index, { query: "search", limit: 1 });

    expect(results).toHaveLength(1);
    // "search" appears in slack, linear, and github — the top-scoring doc wins
    expect(results[0]?.document).toBeDefined();
  });

  it("returns all matching documents when limit >= corpus size", () => {
    const index = createBm25SearchIndex(documents);
    // "search" matches slack, linear, github (3 docs); limit > total corpus
    const results = searchBm25(index, { query: "search", limit: 100 });

    expect(results).toHaveLength(3);
  });

  it("returns only top-k when corpus is larger than limit, in score order", () => {
    // Build a corpus where scores are predictable: only one doc contains a
    // rare token, so it always wins; the rest share a common token.
    const index = createBm25SearchIndex([
      { document: { id: "rare" }, text: "unique rare token" },
      { document: { id: "common1" }, text: "common token" },
      { document: { id: "common2" }, text: "common token" },
      { document: { id: "common3" }, text: "common token" },
      { document: { id: "common4" }, text: "common token" },
    ]);

    const results = searchBm25(index, { query: "unique rare token", limit: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]?.document.id).toBe("rare");
    // second result has a lower score than the first
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("also exposes search on the index object", () => {
    const index = createBm25SearchIndex(documents);

    expect(index.search({ query: "calendar lookup" })).toEqual([
      {
        document: { id: "calendar" },
        score: expect.any(Number),
      },
    ]);
  });
});
