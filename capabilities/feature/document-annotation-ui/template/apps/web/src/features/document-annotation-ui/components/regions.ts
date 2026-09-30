/**
 * The bridge between the capability's OCR contract and the vendored viewer's overlay contract.
 *
 * `OcrPageResult`/`OcrBlockResult` are the wire shape (snake_case corners, 0-based page index).
 * `DetectedRegion` is the viewer shape (camelCase bounds, 1-based page, original page dimensions).
 * Everything the viewer gets is minted here. Region ids are `p{pageIndex}_b{blockIndexWithinPage}`,
 * minted the same way for every producer, so both hover directions resolve to the same region.
 */

import {
  getReferencedRegions,
  getRegionsForField,
  type FieldRegion,
  type OcrBlockResult,
  type OcrDocumentResult,
  type OcrPageResult,
  type SourceMap,
} from "@mistralai-capabilities/feature-document-annotation-ui";
import type { DetectedRegion } from "./document-viewer/index";

export function regionIdFor(pageIndex: number, blockIndex: number): string {
  return `p${pageIndex}_b${blockIndex}`;
}

function countNewlines(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character === "\n") count += 1;
  }
  return count;
}

type OcrLineMapping = {
  regionByLine: Map<number, string>;
  mismatch: { pageIndex: number; blockIndex: number } | null;
};

/**
 * Match each line in the combined OCR markdown back to the block that supplied it.
 *
 * Blocks are searched in document order so repeated headers and footers still resolve to their
 * own page. A multi-line block maps every line it spans, allowing each rendered paragraph, list,
 * or table child to link to the same source region.
 */
export function getOcrRegionIdsByLine(ocr: OcrDocumentResult): OcrLineMapping {
  const regionByLine = new Map<number, string>();
  let cursor = 0;
  let cursorLine = 1;

  for (const page of ocr.pages ?? []) {
    for (const [blockIndex, block] of page.blocks.entries()) {
      if (block.content === "") continue;
      // TODO: Use captured mismatches to choose a mapping that tolerates OCR markdown/block
      // differences. Exact matching is not an API guarantee; keep the full markdown visible when
      // linking stops, and defer a broader rendering change until those examples guide it.
      const start = ocr.ocr_text.indexOf(block.content, cursor);
      // A missing block breaks the document-order invariant. Stop rather than searching the same
      // suffix for every later block or risking that a repeated value is assigned to the wrong one.
      if (start < 0) {
        return { regionByLine, mismatch: { pageIndex: page.index, blockIndex } };
      }

      cursorLine += countNewlines(ocr.ocr_text.slice(cursor, start));
      const endLine = cursorLine + countNewlines(block.content);
      const regionId = regionIdFor(page.index, blockIndex);
      for (let line = cursorLine; line <= endLine; line += 1) {
        regionByLine.set(line, regionId);
      }

      cursor = start + block.content.length;
      cursorLine = endLine;
    }
  }

  return { regionByLine, mismatch: null };
}

/**
 * One block as a viewer region, or `null` when the page carries no usable dimensions.
 *
 * The overlay divides by `originalPageWidth`/`originalPageHeight`, so a zero would place every
 * box at `Infinity`. Dropping the region is the honest outcome — the page still renders.
 */
function toDetectedRegion(
  page: OcrPageResult,
  block: OcrBlockResult,
  blockIndex: number,
  regionNumber: number,
): DetectedRegion | null {
  if (page.width <= 0 || page.height <= 0) return null;
  return {
    id: regionIdFor(page.index, blockIndex),
    pageNumber: page.index + 1,
    bounds: {
      topLeftX: block.top_left_x,
      topLeftY: block.top_left_y,
      bottomRightX: block.bottom_right_x,
      bottomRightY: block.bottom_right_y,
    },
    label: { regionNumber, text: block.type },
    originalPageWidth: page.width,
    originalPageHeight: page.height,
  };
}

export function groupByPageNumber(
  regions: ReadonlyArray<DetectedRegion>,
): Map<number, DetectedRegion[]> {
  const byPage = new Map<number, DetectedRegion[]>();
  for (const region of regions) {
    const bucket = byPage.get(region.pageNumber);
    if (bucket) bucket.push(region);
    else byPage.set(region.pageNumber, [region]);
  }
  return byPage;
}

type IndexedOcrPage = {
  page: OcrPageResult;
  blockIndices: ReadonlyMap<OcrBlockResult, number>;
};

/** OCR lookup shared by field hover and the persistent structured-output overlay. */
export type OcrRegionIndex = {
  ocr: OcrDocumentResult;
  pages: ReadonlyMap<number, IndexedOcrPage>;
};

/** Index every OCR block once; callers memoize the result for the lifetime of an OCR response. */
export function buildOcrRegionIndex(ocr: OcrDocumentResult | null): OcrRegionIndex | null {
  if (!ocr) return null;
  return {
    ocr,
    pages: new Map(
      (ocr.pages ?? []).map((page) => [
        page.index,
        {
          page,
          blockIndices: new Map(page.blocks.map((block, blockIndex) => [block, blockIndex])),
        },
      ]),
    ),
  };
}

/** Every OCR block on every page — what the Raw OCR tab outlines. */
export function getAllOcrRegions(ocr: OcrDocumentResult | null): Map<number, DetectedRegion[]> {
  if (!ocr) return new Map();
  const regions: Array<DetectedRegion> = [];
  let regionNumber = 0;
  for (const page of ocr.pages ?? []) {
    page.blocks.forEach((block, blockIndex) => {
      const region = toDetectedRegion(page, block, blockIndex, regionNumber + 1);
      if (region) {
        regions.push(region);
        regionNumber += 1;
      }
    });
  }
  return groupByPageNumber(regions);
}

/** Only the blocks OCR typed as tables — what the Markdown tab links its rendered tables to. */
export function getTableRegions(ocr: OcrDocumentResult | null): Array<DetectedRegion> {
  if (!ocr) return [];
  const regions: Array<DetectedRegion> = [];
  let tableNumber = 0;
  for (const page of ocr.pages ?? []) {
    page.blocks.forEach((block, blockIndex) => {
      if (block.type !== "table") return;
      const region = toDetectedRegion(page, block, blockIndex, tableNumber + 1);
      if (region) {
        regions.push(region);
        tableNumber += 1;
      }
    });
  }
  return regions;
}

/**
 * The blocks one extracted field was read from.
 *
 * The source resolution lives in the capability (`getRegionsForField` walks `_sources`' global
 * block indices across pages); this only turns the hits into viewer regions. Blocks are indexed by
 * reference once per page because the capability returns the same objects it read from `ocr.pages`.
 * That keeps bulk citation rendering linear and makes the ids match `getAllOcrRegions`.
 */
export function getFieldRegions(
  index: OcrRegionIndex | null,
  sources: SourceMap | null | undefined,
  fieldKey: string | null,
): Map<number, DetectedRegion[]> {
  if (!index || !sources || fieldKey === null) return new Map();

  return toViewerRegions(index, getRegionsForField(index.ocr, sources, fieldKey));
}

/** Every OCR block referenced by at least one extracted field. */
export function getReferencedFieldRegions(
  index: OcrRegionIndex | null,
  sources: SourceMap | null | undefined,
): Map<number, DetectedRegion[]> {
  if (!index || !sources) return new Map();

  return toViewerRegions(index, getReferencedRegions(index.ocr, sources));
}

function toViewerRegions(
  index: OcrRegionIndex,
  hits: ReadonlyArray<FieldRegion>,
): Map<number, DetectedRegion[]> {
  const regions: Array<DetectedRegion> = [];
  let regionNumber = 0;

  for (const hit of hits) {
    const indexedPage = index.pages.get(hit.page);
    if (!indexedPage) continue;
    const blockIndex = indexedPage.blockIndices.get(hit.block);
    if (blockIndex === undefined) continue;
    const region = toDetectedRegion(indexedPage.page, hit.block, blockIndex, regionNumber + 1);
    if (region) {
      regions.push(region);
      regionNumber += 1;
    }
  }

  return groupByPageNumber(regions);
}

/** The first region id in a by-page map, in page order — what the viewer should scroll to. */
export function firstRegionId(byPage: ReadonlyMap<number, DetectedRegion[]>): string | null {
  const pages = [...byPage.keys()].toSorted((a, b) => a - b);
  for (const page of pages) {
    const first = byPage.get(page)?.[0];
    if (first) return first.id;
  }
  return null;
}
