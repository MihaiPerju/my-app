import type { AlignType, Nodes, PhrasingContent, Root } from "mdast";

declare module "mdast" {
  interface Data {
    hName?: string | undefined;
    mistralMarkdown?: MarkdownNodeFlags | undefined;
    tableMetadata?: { readonly title: string } | undefined;
  }
}

export type MarkdownNodeFlags = {
  readonly unfinished?: true;
  readonly optimistic?: true;
};

export type MarkdownNode = {
  alt?: string | null;
  align?: readonly (string | null)[];
  checked?: boolean | null;
  children?: readonly MarkdownNode[];
  data?: {
    hName?: string;
    mistralMarkdown?: MarkdownNodeFlags;
  };
  depth?: number;
  identifier?: string;
  lang?: string | null;
  label?: string;
  ordered?: boolean;
  start?: number | null;
  spread?: boolean;
  title?: string | null;
  type: string;
  url?: string;
  value?: string;
};

export type PendingConstructKind =
  | "blockContinuation"
  | "blockquote"
  | "codeBlock"
  | "codeFence"
  | "emphasis"
  | "footnoteDefinition"
  | "heading"
  | "htmlBlock"
  | "htmlTag"
  | "inlineCode"
  | "inlineBracket"
  | "list"
  | "mathBlock"
  | "mathInline"
  | "paragraph"
  | "referenceDefinition"
  | "strong"
  | "table"
  | "thematicBreak";

export type PendingConstruct = {
  readonly kind: PendingConstructKind;
  readonly startOffset: number;
};

export type InternalSourceLine = {
  readonly endOffset: number;
  readonly hasLineBreak: boolean;
  readonly nextOffset: number;
  readonly startOffset: number;
  readonly text: string;
};

export type InternalCachedSourceLine = Omit<InternalSourceLine, "text">;

export type InternalLinkReferenceDefinition = {
  readonly normalizedLabel: string;
  readonly startOffset: number;
  readonly title?: string;
  readonly url: string;
};

export type InternalBaseBlockState = {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly open: boolean;
};

export type InternalParagraphBlockState = InternalBaseBlockState & {
  readonly kind: "paragraph";
  readonly hasTablePipe: boolean;
  inlineCache?: InternalInlineCache;
  readonly plainAppendSafe: boolean;
  readonly text: string;
};

export type InternalBlockQuoteBlockState = InternalBaseBlockState & {
  readonly kind: "blockquote";
  readonly children: readonly InternalBlockState[];
};

export type InternalHeadingBlockState = InternalBaseBlockState & {
  readonly kind: "heading";
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  inlineCache?: InternalInlineCache;
  readonly text: string;
};

export type InternalThematicBreakBlockState = InternalBaseBlockState & {
  readonly kind: "thematicBreak";
};

export type InternalCodeBlockState = InternalBaseBlockState & {
  readonly kind: "code";
  readonly value: string;
  readonly fenced: boolean;
  readonly lang?: string;
  readonly meta?: string;
  readonly marker?: "`" | "~";
  readonly fenceLength?: number;
};

export type InternalMathBlockState = InternalBaseBlockState & {
  readonly kind: "math";
  readonly value: string;
  readonly meta?: string;
};

export type InternalHtmlBlockState = InternalBaseBlockState & {
  readonly kind: "html";
  readonly value: string;
};

export type InternalFootnoteDefinitionBlockState = InternalBaseBlockState & {
  readonly kind: "footnoteDefinition";
  readonly identifier: string;
  readonly label: string;
  readonly children: readonly InternalBlockState[];
};

export type InternalTableCellState = {
  inlineCache?: InternalInlineCache;
  readonly text: string;
};

export type InternalTableRowState = {
  readonly cells: readonly InternalTableCellState[];
};

export type InternalTableBlockState = InternalBaseBlockState & {
  readonly kind: "table";
  readonly align: readonly AlignType[];
  readonly header?: InternalTableRowState;
  readonly rows: readonly InternalTableRowState[];
};

export type InternalListItemState = InternalBaseBlockState & {
  readonly kind: "listItem";
  readonly checked?: boolean | null;
  readonly hasTrailingSeparatedContent: boolean;
  readonly spread: boolean;
  readonly children: readonly InternalBlockState[];
};

export type InternalListBlockState = InternalBaseBlockState & {
  readonly kind: "list";
  readonly ordered: boolean;
  readonly start?: number;
  readonly spread: boolean;
  readonly items: readonly InternalListItemState[];
};

export type InternalBlockState =
  | InternalBlockQuoteBlockState
  | InternalParagraphBlockState
  | InternalHeadingBlockState
  | InternalThematicBreakBlockState
  | InternalCodeBlockState
  | InternalMathBlockState
  | InternalHtmlBlockState
  | InternalTableBlockState
  | InternalListBlockState;

export type InternalRootBlockState =
  | InternalBlockState
  | InternalFootnoteDefinitionBlockState;

export type InternalFootnoteReferenceDefinition = {
  readonly normalizedLabel: string;
  readonly label: string;
  readonly startOffset: number;
  readonly block: InternalFootnoteDefinitionBlockState;
};

export type InternalInlineAppendContinuation = {
  readonly delimiterLookbehindStart?: number;
  readonly literalAutolinkStart?: number;
};

export type InternalInlineEvent =
  | {
      readonly kind: "delimiter";
      readonly canClose: boolean;
      readonly canOpen: boolean;
      readonly length: number;
      readonly marker: "*" | "_" | "~";
      readonly startIndex: number;
    }
  | {
      readonly kind: "node";
      readonly node: PhrasingContent;
    }
  | {
      readonly kind: "text";
      readonly value: string;
    };

export type InternalInlineCache = {
  readonly appendContinuation?: InternalInlineAppendContinuation;
  readonly children: PhrasingContent[];
  readonly definitions: readonly InternalLinkReferenceDefinition[];
  readonly footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[];
  readonly optimisticChildren?: PhrasingContent[];
  readonly resumeState?: unknown;
  readonly stablePrefixChildren: PhrasingContent[];
  readonly stablePrefixLength: number;
  readonly text: string;
};

export type InternalMarkdownState = {
  version: 3;
  source: string;
  appendedChunk: string | null;
  appendStartOffset: number | null;
  reparseFromOffset: number;
  lineCache: readonly InternalCachedSourceLine[];
  lineCacheSourceLength: number;
  lineCacheStartOffset: number;
  finalized: boolean;
  pendingConstructs: PendingConstruct[];
  blocks: InternalRootBlockState[];
  referenceDefinitionIndex: Map<string, InternalLinkReferenceDefinition>;
  referenceDefinitions: InternalLinkReferenceDefinition[];
  footnoteDefinitionIndex: Map<string, InternalFootnoteReferenceDefinition>;
  footnoteDefinitions: InternalFootnoteReferenceDefinition[];
};

export type MarkdownDiagnostic = {
  readonly code: "not-implemented" | "unfinished-input";
  readonly message: string;
  readonly offset: number;
};

export type MarkdownSnapshot = {
  readonly ast: Root;
  readonly diagnostics: readonly MarkdownDiagnostic[];
  readonly finalized: boolean;
  readonly sourceLength: number;
};

export type UnstableMarkdownTransform = {
  readonly parentTypes: readonly string[];
  readonly transform: (children: readonly Nodes[]) => readonly Nodes[];
};

export type MarkdownOptions = {
  /**
   * Product-owned AST projections.
   *
   * React sessions capture this array when the hook is created. Remount the
   * component if the transform set itself needs to change.
   */
  readonly unstable_transforms?: readonly UnstableMarkdownTransform[];
};

export type InternalMarkdownResult = {
  readonly snapshot: MarkdownSnapshot;
  readonly state: InternalMarkdownState;
};

export type MarkdownSession = {
  parse(source: string, isDone?: boolean): MarkdownSnapshot;
};
