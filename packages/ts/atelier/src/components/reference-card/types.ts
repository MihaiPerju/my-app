/**
 * Content displayed as a document, web page, file, generated asset, attachment,
 * or product-specific output.
 */
export interface Reference {
  /** Stable identity for the reference. */
  id: string;
  /** Primary label shown in the card header. */
  title: string;
  /** Optional URL to open when the reference is selected. */
  href?: string;
  /** Preview, excerpt, generated summary, caption, or other supporting text. */
  description?: string;
  /** Human-readable source or container label shown in the footer. */
  origin?: string;
  /** Position inside the target, such as `p.12`, `Sheet1`, or `api.ts:42`. */
  locator?: string;
  /** Optional relevance or confidence score in `[0, 1]`, shown as a percentage. */
  score?: number;
}
