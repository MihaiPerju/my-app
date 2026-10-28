import { realWorldMarkdownFixtures } from "../tests/fixtures/real-world-messages.js";

export type BenchmarkMode = "full" | "streaming";

export type BenchmarkCase = {
  readonly batchSize: number;
  readonly chunks?: readonly string[];
  readonly minTotalMs: number;
  readonly mode: BenchmarkMode;
  readonly name: string;
  readonly source: string;
  readonly warmupBatches?: number;
};

function joinBlocks(blocks: readonly string[]): string {
  return `${blocks.join("\n\n")}\n`;
}

function repeatSections(
  sectionCount: number,
  createSection: (sectionIndex: number) => readonly string[],
): string[] {
  const blocks: string[] = [];

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    blocks.push(...createSection(sectionIndex));
  }

  return blocks;
}

function createTokenChunks(
  source: string,
  chunkSizes: readonly number[],
): string[] {
  if (source.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  let offset = 0;
  let sizeIndex = 0;

  while (offset < source.length) {
    const chunkSize = chunkSizes[sizeIndex % chunkSizes.length] ?? 1;
    const nextOffset = Math.min(source.length, offset + chunkSize);

    chunks.push(source.slice(offset, nextOffset));
    offset = nextOffset;
    sizeIndex += 1;
  }

  return chunks;
}

function createBenchmarkCase(
  mode: BenchmarkMode,
  name: string,
  source: string,
  batchSize: number,
  minTotalMs: number,
  chunks?: readonly string[],
  warmupBatches?: number,
): BenchmarkCase {
  return {
    name,
    mode,
    source,
    batchSize,
    minTotalMs,
    chunks,
    warmupBatches,
  };
}

function createShortReplySource(): string {
  return [
    "The parser should keep snapshots immutable, reuse stable nodes, and only revisit the unfinished `tail` while tokens stream into the session.",
    "That keeps rendering responsive even before the final newline arrives.",
  ].join(" ");
}

function createLongProseSection(sectionIndex: number): readonly string[] {
  const sectionNumber = sectionIndex + 1;

  return [
    `Section ${sectionNumber} explains why the assistant answer stays readable while it streams, with mostly plain prose, occasional *emphasis*, and a short \`code-${sectionNumber}\` marker for realism.`,
    `The follow-up paragraph ${sectionNumber} keeps the tail prose-heavy, references https://example.com/notes/${sectionNumber}, and avoids extra structure so the benchmark reflects ordinary long-form chat output rather than synthetic syntax stress alone.`,
  ];
}

function createStructuredAnswerSection(
  sectionIndex: number,
): readonly string[] {
  const sectionNumber = sectionIndex + 1;

  return [
    `## Step ${sectionNumber}`,
    `This section combines [guide ${sectionNumber}](/guides/${sectionNumber}), *emphasis*, **strong text**, and \`snippet-${sectionNumber}\` while the assistant walks through a multi-step answer.`,
    `- first action ${sectionNumber}\n- second action ${sectionNumber}\n- third action ${sectionNumber}`,
    `1. ordered step ${sectionNumber}.1\n2. ordered step ${sectionNumber}.2`,
    `> A short quoted reminder ${sectionNumber} keeps block variety realistic without turning the corpus into an edge-case zoo.`,
    sectionNumber % 2 === 0
      ? `\`\`\`ts\nexport const step${sectionNumber} = ${sectionNumber};\nconsole.log(step${sectionNumber});\n\`\`\``
      : `| key ${sectionNumber} | value ${sectionNumber} |\n| --- | ---: |\n| alpha | beta |\n| gamma | delta |`,
  ];
}

function createWorkingStepsSection(sectionIndex: number): readonly string[] {
  const sectionNumber = sectionIndex + 1;

  return [
    `- Step ${sectionNumber}: inspect the streamed message state before changing the cache.`,
    `  - Read the current trace around \`parseFromState\`, \`parseListItem\`, and \`createInlineCache\`.`,
    `  - Compare the saved profile with https://example.com/mobile/profile/${sectionNumber} and keep only changes that move parser CPU.`,
    `  - Check whether the expensive path is caused by nested bullet ${sectionNumber}, lazy paragraph continuation, or a late [reference ${sectionNumber}](/runs/${sectionNumber}/reference).`,
    `- Step ${sectionNumber}: update the implementation plan.`,
    `  1. Keep the source of truth inside the markdown session.`,
    `  2. Avoid rebuilding finalized siblings while the assistant is still streaming token-sized chunks.`,
    `  3. Record any remaining risk in the owner note instead of hiding it behind a helper.`,
    `- Step ${sectionNumber}: verify the output.`,
    `  - Run the list-heavy benchmark on Node and Hermes when available.`,
    `  - Re-run the broad suite so table-heavy, math-heavy, prose-heavy, and code-fence cases do not regress.`,
    `  - If the final chunk arrives without a newline, preserve the same AST as one-shot parsing.`,
  ];
}

function createMathPriceSection(sectionIndex: number): readonly string[] {
  const sectionNumber = sectionIndex + 1;

  return [
    `The estimate for iteration ${sectionNumber} moved from $${sectionNumber + 9}.99 to $${sectionNumber + 19}.99, while the derivation still uses inline $m_${sectionNumber}$ and \\(f_${sectionNumber}(x) = x^2 + ${sectionNumber}\\).`,
    `A second paragraph keeps literal dollars dense with $${sectionNumber + 29}.50, ${sectionNumber + 7}$ credits, and one true expression $a_${sectionNumber} + b_${sectionNumber}$ in the same chat-style response.`,
    `\\[\nS_${sectionNumber} = \\sum_{i=1}^{${sectionNumber + 3}} i^2\n\\]`,
  ];
}

function createLateLinkTailChunks(
  stablePrefix: string,
  label: string,
  destination: string,
): string[] {
  return [
    stablePrefix,
    "\nClosing note points to [",
    ...createTokenChunks(label, [5, 4, 6, 3, 7, 4]),
    "](",
    ...createTokenChunks(destination, [6, 5, 4, 7, 3]),
    ") when the answer reaches its last sentence.\n",
  ];
}

function createLateParagraphContinuationChunks(
  stablePrefix: string,
  continuationLine: string,
): string[] {
  return [
    stablePrefix,
    ...createTokenChunks(continuationLine, [8, 7, 9, 6, 10, 5]),
  ];
}

function createLateLiteralAutolinkTailChunks(
  stablePrefix: string,
  localPartPrefix: string,
  localPartSuffix: string,
  domain: string,
): string[] {
  return [
    stablePrefix,
    "\nFollow-up contact is ",
    localPartPrefix,
    localPartSuffix,
    "@",
    ...createTokenChunks(domain, [6, 5, 4, 7, 3]),
    " once the answer reaches its final line.\n",
  ];
}

function createCodeReplySource(): string {
  return [
    "Here is the implementation:",
    "",
    "```ts",
    "export function fib(n: number): number {",
    "  if (n <= 1) return n;",
    "  return fib(n - 1) + fib(n - 2);",
    "}",
    "```",
    "",
    "This version is intentionally simple.",
  ].join("\n");
}

function createRealWorldCorpusSource(): string {
  return joinBlocks(
    realWorldMarkdownFixtures.slice(0, 24).map((fixture) => fixture.source),
  );
}

function findRealWorldFixtureSource(bucket: string): string {
  const fixture = realWorldMarkdownFixtures.find((candidate) =>
    (candidate.buckets as readonly string[]).includes(bucket),
  );

  if (fixture === undefined) {
    throw new Error(`Missing real-world markdown fixture bucket: ${bucket}`);
  }

  return fixture.source;
}

function selectRealWorldFixtureSource(index: number): string {
  const fixture = realWorldMarkdownFixtures[index];

  if (fixture === undefined) {
    throw new Error(`Missing real-world markdown fixture: ${index}`);
  }

  return fixture.source;
}

const SHORT_REPLY_SOURCE = createShortReplySource();
const SHORT_REPLY_CHUNKS = createTokenChunks(
  SHORT_REPLY_SOURCE,
  [4, 3, 5, 2, 6, 4],
);
const SHORT_REPLY_CHARACTER_CHUNKS = createTokenChunks(SHORT_REPLY_SOURCE, [1]);

const LONG_PROSE_SOURCE = joinBlocks(
  repeatSections(32, createLongProseSection),
);
const LONG_PROSE_CHUNKS = createTokenChunks(
  LONG_PROSE_SOURCE,
  [48, 36, 64, 40, 56, 72],
);

const STRUCTURED_ANSWER_SOURCE = joinBlocks(
  repeatSections(18, createStructuredAnswerSection),
);
const WORKING_STEPS_SOURCE = joinBlocks(
  repeatSections(12, createWorkingStepsSection),
);
const WORKING_STEPS_CHUNKS = createTokenChunks(
  WORKING_STEPS_SOURCE,
  [7, 11, 5, 13, 8, 3, 17, 6, 10],
);
const MATH_AND_PRICES_SOURCE = joinBlocks(
  repeatSections(20, createMathPriceSection),
);
const MATH_AND_PRICES_CHUNKS = createTokenChunks(
  MATH_AND_PRICES_SOURCE,
  [32, 24, 40, 28, 36, 20],
);

const LATE_LINK_LABEL =
  "the final migration guide for the streaming markdown session";
const LATE_LINK_DESTINATION = "/docs/streaming-markdown-session-benchmark-plan";
const LATE_LINK_TAIL_SOURCE = `${LONG_PROSE_SOURCE}\nClosing note points to [${LATE_LINK_LABEL}](${LATE_LINK_DESTINATION}) when the answer reaches its last sentence.\n`;
const LATE_LINK_TAIL_CHUNKS = createLateLinkTailChunks(
  LONG_PROSE_SOURCE,
  LATE_LINK_LABEL,
  LATE_LINK_DESTINATION,
);
const LATE_PARAGRAPH_CONTINUATION_LINE =
  "The final streamed sentence still belongs to the previous paragraph and mentions https://example.com/final-paragraph-tail.\n";
const LATE_PARAGRAPH_CONTINUATION_SOURCE = `${LONG_PROSE_SOURCE}${LATE_PARAGRAPH_CONTINUATION_LINE}`;
const LATE_PARAGRAPH_CONTINUATION_CHUNKS =
  createLateParagraphContinuationChunks(
    LONG_PROSE_SOURCE,
    LATE_PARAGRAPH_CONTINUATION_LINE,
  );
const LATE_LITERAL_AUTOLINK_LOCAL_PART_PREFIX = "ml_research_";
const LATE_LITERAL_AUTOLINK_LOCAL_PART_SUFFIX = "ops";
const LATE_LITERAL_AUTOLINK_DOMAIN = "example.com";
const LATE_LITERAL_AUTOLINK_TAIL_SOURCE = `${LONG_PROSE_SOURCE}\nFollow-up contact is ${LATE_LITERAL_AUTOLINK_LOCAL_PART_PREFIX}${LATE_LITERAL_AUTOLINK_LOCAL_PART_SUFFIX}@${LATE_LITERAL_AUTOLINK_DOMAIN} once the answer reaches its final line.\n`;
const LATE_LITERAL_AUTOLINK_TAIL_CHUNKS = createLateLiteralAutolinkTailChunks(
  LONG_PROSE_SOURCE,
  LATE_LITERAL_AUTOLINK_LOCAL_PART_PREFIX,
  LATE_LITERAL_AUTOLINK_LOCAL_PART_SUFFIX,
  LATE_LITERAL_AUTOLINK_DOMAIN,
);
const CODE_REPLY_SOURCE = createCodeReplySource();
const CODE_REPLY_CHUNKS = [
  "Here is the implementation:\n\n```",
  "ts\nexport function fib(n: number): number {\n",
  "  if (n <= 1) return n;\n",
  "  return fib(n - 1) + fib(n - 2);\n",
  "}\n",
  "```\n\n",
  "This version is intentionally simple.\n",
] as const;
const REAL_WORLD_CORPUS_SOURCE = createRealWorldCorpusSource();
const REAL_WORLD_STREAMING_SOURCE = findRealWorldFixtureSource("table");
const REAL_WORLD_STREAMING_CHUNKS = createTokenChunks(
  REAL_WORLD_STREAMING_SOURCE,
  [5, 3, 8, 2, 13, 4, 6],
);
const REAL_WORLD_HTML_CODE_STREAMING_SOURCE = selectRealWorldFixtureSource(7);
const REAL_WORLD_HTML_CODE_STREAMING_CHUNKS = createTokenChunks(
  REAL_WORLD_HTML_CODE_STREAMING_SOURCE,
  [7, 11, 5, 13, 8, 3, 17, 6, 10],
);
const REAL_WORLD_MATH_HTML_STREAMING_SOURCE = selectRealWorldFixtureSource(12);
const REAL_WORLD_MATH_HTML_STREAMING_CHUNKS = createTokenChunks(
  REAL_WORLD_MATH_HTML_STREAMING_SOURCE,
  [7, 11, 5, 13, 8, 3, 17, 6, 10],
);
const REAL_WORLD_MIXED_STREAMING_SOURCE = selectRealWorldFixtureSource(0);
const REAL_WORLD_MIXED_STREAMING_CHUNKS = createTokenChunks(
  REAL_WORLD_MIXED_STREAMING_SOURCE,
  [7, 11, 5, 13, 8, 3, 17, 6, 10],
);

export const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  createBenchmarkCase(
    "full",
    "short assistant reply",
    SHORT_REPLY_SOURCE,
    40,
    200,
  ),
  createBenchmarkCase("full", "long prose answer", LONG_PROSE_SOURCE, 5, 200),
  createBenchmarkCase(
    "full",
    "structured answer",
    STRUCTURED_ANSWER_SOURCE,
    3,
    200,
  ),
  createBenchmarkCase(
    "full",
    "math and prices answer",
    MATH_AND_PRICES_SOURCE,
    3,
    200,
  ),
  createBenchmarkCase(
    "full",
    "working steps list-heavy answer",
    WORKING_STEPS_SOURCE,
    3,
    200,
  ),
  createBenchmarkCase(
    "full",
    "real-world assistant corpus",
    REAL_WORLD_CORPUS_SOURCE,
    1,
    200,
  ),
  createBenchmarkCase(
    "streaming",
    "short assistant reply - burst stream",
    SHORT_REPLY_SOURCE,
    8,
    200,
    SHORT_REPLY_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "short assistant reply - typewriter reveal",
    SHORT_REPLY_SOURCE,
    1,
    150,
    SHORT_REPLY_CHARACTER_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "long prose answer - burst stream",
    LONG_PROSE_SOURCE,
    1,
    150,
    LONG_PROSE_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "code reply - open fence stream",
    CODE_REPLY_SOURCE,
    1,
    150,
    CODE_REPLY_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "long prose answer - late link tail",
    LATE_LINK_TAIL_SOURCE,
    1,
    150,
    LATE_LINK_TAIL_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "long prose answer - late paragraph continuation",
    LATE_PARAGRAPH_CONTINUATION_SOURCE,
    1,
    150,
    LATE_PARAGRAPH_CONTINUATION_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "long prose answer - late literal autolink tail",
    LATE_LITERAL_AUTOLINK_TAIL_SOURCE,
    1,
    150,
    LATE_LITERAL_AUTOLINK_TAIL_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "math and prices answer - burst stream",
    MATH_AND_PRICES_SOURCE,
    1,
    150,
    MATH_AND_PRICES_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "working steps list-heavy answer - token stream",
    WORKING_STEPS_SOURCE,
    1,
    150,
    WORKING_STEPS_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "real-world table-heavy reply - token stream",
    REAL_WORLD_STREAMING_SOURCE,
    1,
    150,
    REAL_WORLD_STREAMING_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "real-world html code reply - token stream",
    REAL_WORLD_HTML_CODE_STREAMING_SOURCE,
    1,
    150,
    REAL_WORLD_HTML_CODE_STREAMING_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "real-world math html reply - token stream",
    REAL_WORLD_MATH_HTML_STREAMING_SOURCE,
    1,
    150,
    REAL_WORLD_MATH_HTML_STREAMING_CHUNKS,
    1,
  ),
  createBenchmarkCase(
    "streaming",
    "real-world mixed reply - token stream",
    REAL_WORLD_MIXED_STREAMING_SOURCE,
    1,
    150,
    REAL_WORLD_MIXED_STREAMING_CHUNKS,
    1,
  ),
] as const;
