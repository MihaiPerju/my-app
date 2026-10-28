/**
 * Reserved model-authored reason field for confirmation-gated tool calls.
 *
 * When a tool opts into the confirmation-reason protocol via
 * `withConfirmation({ requireConfirmationReason: true })`, the harness augments
 * the tool's model-facing input schema with this property. The model fills it
 * with a short user-facing sentence explaining what the call will do; the
 * wrapper strips it before constructing the child call so underlying
 * validation/execution receive exactly the original arguments.
 *
 * Shared here (rather than in the harness SDK alone) so the server-side
 * augmentation, the shared frontend normalization, and telemetry all agree on
 * the exact field name, cap, and guidance text without a runtime edge between
 * them.
 */
export const CONFIRMATION_REASON_FIELD = "_confirmationReason";

export const CONFIRMATION_REASON_MAX_LENGTH = 200;

export const CONFIRMATION_REASON_FIELD_DESCRIPTION =
  "One short user-facing sentence explaining what this exact call will do and why it is needed for the current request. Include specific action, target, or outcome; do not use generic permission language or include secrets. Use the user's language.";

/**
 * Telemetry/classification status for the reserved confirmation-reason field.
 *
 * Shared across the harness augmentation, server-side telemetry, and the
 * frontend normalization so every layer classifies persisted input identically
 * and never emits the reason text itself.
 */
export type ConfirmationReasonStatus =
  | "valid"
  | "missing"
  | "invalid"
  | "oversized";

/**
 * Parsed confirmation reason: the bounded status plus the trimmed text, but
 * only when the value is displayable (`status === "valid"`).
 */
export interface ParsedConfirmationReason {
  status: ConfirmationReasonStatus;
  text: string | undefined;
}

/**
 * Parses the reserved `_confirmationReason` property on an untrusted,
 * persisted tool-call input into a typed value.
 *
 * This is the single place that decides whether the reserved field is a
 * non-blank string of at most {@link CONFIRMATION_REASON_MAX_LENGTH}
 * characters. Every other layer (the harness extract/strip helpers, the
 * server-side telemetry classifier, the frontend normalization) derives from
 * this so the null/object/string/length distinction lives here once instead of
 * being re-implemented (and drifting) per consumer.
 *
 * - `valid`: present, a string, non-blank after trimming, and at most the cap;
 *   `text` holds the trimmed value.
 * - `missing`: the property is absent or nullish (including non-object inputs);
 *   `text` is `undefined`.
 * - `invalid`: present but not a string, or blank after trimming; `text` is
 *   `undefined`.
 * - `oversized`: a non-blank string longer than the cap; `text` is `undefined`.
 *
 * Accepts `unknown` because persisted callback input is model-authored JSON
 * that may predate the protocol or be malformed across releases. The trimmed
 * text is returned only when displayable, so callers that thread the result
 * through telemetry can rely on `status` alone being safe to log.
 */
export function parseConfirmationReason(
  input: unknown,
): ParsedConfirmationReason {
  if (input === null || typeof input !== "object") {
    return { status: "missing", text: undefined };
  }

  const value = (input as Record<string, unknown>)[CONFIRMATION_REASON_FIELD];
  if (value === undefined || value === null) {
    return { status: "missing", text: undefined };
  }

  if (typeof value !== "string") {
    return { status: "invalid", text: undefined };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { status: "invalid", text: undefined };
  }

  if (trimmed.length > CONFIRMATION_REASON_MAX_LENGTH) {
    return { status: "oversized", text: undefined };
  }

  return { status: "valid", text: trimmed };
}

/**
 * Classifies the reserved `_confirmationReason` property on an untrusted,
 * persisted tool-call input.
 *
 * Thin derivation over {@link parseConfirmationReason} returning only the
 * bounded status, so it is safe to thread through telemetry. See
 * {@link parseConfirmationReason} for the full status semantics.
 */
export function classifyConfirmationReason(
  input: unknown,
): ConfirmationReasonStatus {
  return parseConfirmationReason(input).status;
}
