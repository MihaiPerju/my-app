export type SpecCaseStatus =
  | "pass"
  | "fail"
  | "not_implemented"
  | "error"
  | "skip";

export type SpecExample = {
  readonly suite: string;
  readonly number: number;
  readonly section: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly markdown: string;
  readonly html: string;
  readonly extensions: readonly string[];
  readonly sourcePath?: string;
};

export type SpecEvaluation = {
  readonly status: SpecCaseStatus;
  readonly message?: string;
};

export type SpecCaseResult = {
  readonly example: SpecExample;
  readonly evaluation: SpecEvaluation;
};

export type SpecRunCounts = {
  pass: number;
  fail: number;
  notImplemented: number;
  error: number;
  skip: number;
};

export type SpecRunReport = {
  readonly suite: string;
  readonly adapterName: string;
  readonly totalExamples: number;
  readonly implementedExamples: number;
  readonly passRate: number;
  readonly implementedRate: number;
  readonly counts: SpecRunCounts;
  readonly results: readonly SpecCaseResult[];
};

export type SpecInventorySection = {
  readonly section: string;
  readonly exampleCount: number;
};

export type SpecInventory = {
  readonly suite: string;
  readonly totalExamples: number;
  readonly totalSections: number;
  readonly sections: readonly SpecInventorySection[];
  readonly extensions: readonly string[];
};

export type SpecFilterOptions = {
  readonly onlyNumber?: number;
  readonly sectionPattern?: RegExp;
  readonly limit?: number;
};

export type SpecAdapter = {
  readonly name: string;
  evaluate(example: SpecExample): SpecEvaluation | Promise<SpecEvaluation>;
};
