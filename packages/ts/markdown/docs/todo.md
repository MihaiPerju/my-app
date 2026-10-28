# TODO

This file lists user-visible behavior needed for full Le Chat Mobile migration
and parser readiness across monorepo markdown use-cases.

## Decisions Not To Reopen

- `mermaid` and `svg` code-fence previews are implemented in Le Chat web's
  React code-block renderer, not in the markdown parser or remark plugins. The
  parser only needs to preserve fenced code `lang` and `value`.
- Legacy `:refs[...]` and `:tool_references[...]` are already serialized as
  custom elements when the Le Chat formatter runs with `mistralMarkdown`.
- `::table` metadata is already represented as a custom element and attached to
  the next root table by the Le Chat markdown transforms.
- `:custom-element[...]` inputs are already represented as `<custom-element ...>`
  HTML for the Mistral path and decoded by the Le Chat markdown transforms.
- Invalid or unknown custom elements are already hidden by the Le Chat markdown
  transforms.
- `llmCompatibilityTransforms` normalizes literal `<br>` HTML leaves. The
  `MistralMarkdown` component applies this transform set. Direct parser and
  hook users must add this transform set.
- Registered special URI links such as `component://...` are supported by the
  `liftSpecialUriLinks` transform when the renderer provides a predicate for
  block-level special URI links.
- `summary-citation://...` links are ordinary markdown links. Meeting Notes owns
  their citation popover, analytics, unresolved-link fallback, and export
  stripping behavior.
- Harness reasoning markdown is outside the current migration target. The parser
  already supports the reusable syntax pieces used there: GFM, math, optimistic
  unfinished formatting, literal `<br>` normalization, custom elements, and
  special URI link lifting.
- Raw HTML and JSX-ish corpus mismatches are accepted. The parser preserves
  markdown HTML semantics; Mobile does not render raw HTML nodes, and product
  custom elements are handled by transforms.
- SVG-ish malformed raw HTML autolink differences are accepted. Valid
  links/images remain supported, and escaping unsafe URL characters is safer
  than matching remark's raw `>` preservation in malformed SVG attributes.
- Repeated thematic-break collapse is a legacy model-output cleanup and is not
  part of the parser or Mobile migration. Repeated `---` separators remain valid
  markdown and render as repeated separators.
- `:followup[...]` is deprecated and intentionally unsupported by the Mistral
  path.
- Old Mobile platform-specific custom-element spacing was a pre-`SelectableArea`
  workaround. Exact Android/iOS spacing parity is not a requirement unless a new
  visible regression appears. This includes spacing after bare autolink URLs.
- Mobile markdown image behavior is renderer-owned and already shared by the
  Remark and Mistral AST paths: whitelisted image URLs render through
  `ImageViewer`, blocked URLs render as links, and gallery URLs are extracted
  from the parsed AST.
- Generated `file_reference` chunks are serialized as safe markdown links before
  rendering. Tracking issue for review/backport: MOB-1800.
- Canvas-adjacent dangling code fences are stripped by
  `processAssistantMessageChunks()` before persisted `canva` and streaming
  `draft_canva` parts.
- Deep Research markdown only requires standard markdown and tool-reference
  rendering. Tool references are covered on both legacy directives and Mistral
  custom-element paths; generic embedded custom elements are not expected in
  this markdown surface.
- Smoothed streaming publication already accelerates with backlog size and
  bypasses smoothing for finalized input.

## Future Study

- Evaluate AST-level smoothing after parsing. Current smoothing reveals source
  before parsing; AST-level smoothing could avoid parser-level suppression
  pauses, but it needs a concrete design for timing, structural sharing, and
  partial-node publication before it is worth implementing.

## App Renderer Parity

- Add a Le Chat web AST-to-`RichTableData` adapter so rich tables do not depend
  on `react-markdown` React-child extraction. Preserve current link text,
  followup snippet, and inner-HTML handling.

## Mobile streaming presentation

- Update Mobile Storybook streaming examples that still label supported
  optimistic cases as “not handled yet”.
