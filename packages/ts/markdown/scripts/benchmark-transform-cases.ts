import type { Nodes } from "mdast";

import { serializeCustomElementToMarkdownTag } from "../../le-chat-client-common/src/custom-elements/client-custom-element.ts";
import { createLeChatMarkdownTransforms } from "../../le-chat-client-common/src/messages/mistral-markdown-transforms.ts";
import {
  serializeReferencesCustomElement,
  serializeToolReferencesCustomElement,
} from "../../le-chat-client-common/src/messages/references/references.ts";
import type { UnstableMarkdownTransform } from "../src/index.js";

export type TransformBenchmarkVariant = {
  readonly label: string;
  readonly unstable_transforms?: readonly UnstableMarkdownTransform[];
};

function createTokenChunks(source: string, chunkSizes: readonly number[]) {
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

function createTransformSource(): string {
  const blocks: string[] = [];

  for (let index = 1; index <= 12; index += 1) {
    blocks.push(
      `## Section ${index}`,
      `Before ${serializeCustomElementToMarkdownTag({
        type: "image",
        attributes: { referenceId: `image-${index}` },
      })} after with **strong text**, [link ${index}](/docs/${index}), and ${serializeReferencesCustomElement(
        {
          contentChunkIndex: index,
          referenceIds: [`reference-${index}`, `reference-${index + 100}`],
        },
      )}.`,
      serializeToolReferencesCustomElement([
        {
          title: `Tool reference ${index}`,
          description: null,
          favicon: null,
          url: `https://example.com/${index}`,
        },
      ]),
      serializeCustomElementToMarkdownTag({
        type: "table-metadata",
        attributes: { title: `Table ${index}` },
      }),
      `| Name | Value |\n| --- | ---: |\n| p50 | ${index * 10}ms |\n| p95 | ${index * 20}ms |`,
    );
  }

  return `${blocks.join("\n\n")}\n`;
}

function decodeKind(value: string): string | null {
  const marker = 'data-kind="';
  const start = value.indexOf(marker);

  if (start === -1) return null;

  const valueStart = start + marker.length;
  const valueEnd = value.indexOf('"', valueStart);

  return valueEnd === -1 ? null : value.slice(valueStart, valueEnd);
}

const noopTransform = {
  parentTypes: ["root", "paragraph"],
  transform(children) {
    return children;
  },
} satisfies UnstableMarkdownTransform;

const customProjectionTransform = {
  parentTypes: ["root", "paragraph"],
  transform(children) {
    let next: Nodes[] | undefined;
    let pendingTableTitle: string | null = null;

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];

      if (child?.type === "html") {
        const kind = decodeKind(child.value);

        if (kind !== null && child.value.startsWith("<table-title")) {
          pendingTableTitle = kind;
          next ??= children.slice(0, index);
          continue;
        }

        if (kind !== null) {
          next ??= children.slice(0, index);
          next.push({
            type: "custom-element",
            data: {
              kind,
            },
          } as unknown as Nodes);
          continue;
        }
      }

      if (child?.type === "table" && pendingTableTitle !== null) {
        next ??= children.slice(0, index);
        next.push({
          ...child,
          data: {
            ...child.data,
            tableMetadata: {
              title: pendingTableTitle,
            },
          },
        });
        pendingTableTitle = null;
        continue;
      }

      if (next !== undefined && child !== undefined) {
        next.push(child);
      }
    }

    return next ?? children;
  },
} satisfies UnstableMarkdownTransform;

export const TRANSFORM_BENCHMARK_SOURCE = createTransformSource();

export const TRANSFORM_BENCHMARK_CHUNKS = createTokenChunks(
  TRANSFORM_BENCHMARK_SOURCE,
  [5, 3, 8, 2, 13, 4, 6],
);

export const TRANSFORM_BENCHMARK_VARIANTS: readonly TransformBenchmarkVariant[] =
  [
    {
      label: "no transforms",
    },
    {
      label: "noop unstable_transforms",
      unstable_transforms: [noopTransform],
    },
    {
      label: "custom unstable_transforms",
      unstable_transforms: [customProjectionTransform],
    },
    {
      label: "Le Chat unstable_transforms",
      unstable_transforms: createLeChatMarkdownTransforms(),
    },
  ];
