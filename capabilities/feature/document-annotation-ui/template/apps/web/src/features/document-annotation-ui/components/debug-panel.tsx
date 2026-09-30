/**
 * The Debug tab: what the run was started with, read back.
 *
 * The schema shown is the resolved one, the only place the JSON behind `schema_name` is visible. The
 * operator-editable system prompt and the validation errors (which fields the schema refused) are
 * here too. The workflow's `show_debug` gates this tab, declared once in `workflows_catalog.py`.
 */

import type { SchemaFieldError } from "@mistralai-capabilities/feature-document-annotation-ui";
import type { ExtractionSchema } from "./extraction-schema";

const SECTION_TITLE = "text-default text-sm font-semibold";
const EMPTY_NOTE = "text-muted text-sm italic";

/**
 * The app's canonical JSON treatment, taken from `JsonInspector` so a schema reads the same here as
 * elsewhere in the shell.
 */
const JSON_BLOCK =
  "border-default bg-default text-default max-h-96 overflow-auto rounded border p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words";

/**
 * Read-only, resizable, and twelve rows tall to start. The default system prompt runs long, and a
 * short box hides the sentence that skewed the run.
 */
const PROMPT_BLOCK =
  "border-default bg-input text-default min-h-32 w-full resize-y rounded border p-3 text-sm leading-6 focus:outline-none";

const PROMPT_ROWS = 12;

export function DebugPanel({
  extractionSchema,
  schemaName,
  prompt,
  validationErrors,
}: {
  extractionSchema: ExtractionSchema | null;
  schemaName: string | null | undefined;
  prompt: string | null | undefined;
  validationErrors: ReadonlyArray<SchemaFieldError> | null | undefined;
}) {
  const schemaText = extractionSchema ? JSON.stringify(extractionSchema, null, 2) : null;
  const promptText = prompt?.trim() ?? "";
  const errors = validationErrors ?? [];

  return (
    <div className="h-full space-y-4 overflow-x-hidden overflow-y-auto p-4">
      <section className="space-y-2">
        <h3 className={SECTION_TITLE}>Document type</h3>
        {schemaName ? (
          <p className="text-default font-mono text-xs">{schemaName}</p>
        ) : (
          <p className={EMPTY_NOTE}>No registered document type recorded.</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className={SECTION_TITLE}>Extraction schema</h3>
        {schemaText === null ? (
          <p className={EMPTY_NOTE}>No schema recorded.</p>
        ) : (
          <pre className={JSON_BLOCK}>
            <code>{schemaText}</code>
          </pre>
        )}
      </section>

      <section className="space-y-2">
        <h3 className={SECTION_TITLE}>System prompt</h3>
        {promptText === "" ? (
          <p className={EMPTY_NOTE}>No prompt recorded.</p>
        ) : (
          <textarea
            aria-label="System prompt"
            className={PROMPT_BLOCK}
            readOnly
            rows={PROMPT_ROWS}
            spellCheck={false}
            value={promptText}
          />
        )}
      </section>

      <section className="space-y-2">
        <h3 className={SECTION_TITLE}>Validation errors</h3>
        {errors.length === 0 ? (
          <p className={EMPTY_NOTE}>The extraction satisfied the schema.</p>
        ) : (
          <ul className="space-y-1">
            {errors.map((error) => (
              <li className="text-sm leading-5" key={`${error.path}:${error.message}`}>
                <span className="text-destructive font-mono text-xs">{error.path}</span>
                <span className="text-muted"> — {error.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
