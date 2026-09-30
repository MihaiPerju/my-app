/**
 * The HTML tab: preview/editor toggle over an html-valued extracted field.
 *
 * Rendered only when the run's schema produced one (`extracted.data.html` is a string). The preview
 * is a fully sandboxed iframe (`sandbox=""` grants nothing). The markup is untrusted model output
 * from an uploaded document, so it must not reach this page's origin.
 */

import { useState } from "react";

import { Tab, Tabs, TabsList } from "@mistralai/ui/tabs";
import { EyeIcon, PencilSimpleIcon } from "@phosphor-icons/react";

type ViewMode = "preview" | "editor";

function isViewMode(value: string): value is ViewMode {
  return value === "preview" || value === "editor";
}

export function HtmlPanel({
  html,
  editable,
  onChange,
}: {
  html: string;
  editable: boolean;
  onChange: (html: string) => void;
}) {
  const [mode, setMode] = useState<ViewMode>("preview");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-default flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
        <Tabs
          onValueChange={(value) => {
            if (isViewMode(value)) setMode(value);
          }}
          value={mode}
        >
          <TabsList>
            <Tab value="preview">
              <EyeIcon aria-hidden className="mr-1 size-3" />
              Preview
            </Tab>
            <Tab value="editor">
              <PencilSimpleIcon aria-hidden className="mr-1 size-3" />
              Editor
            </Tab>
          </TabsList>
        </Tabs>
      </div>

      {mode === "editor" ? (
        <div className="flex-1 overflow-hidden p-4">
          <textarea
            className="border-default text-default read-only:bg-subtle h-full w-full resize-none rounded border bg-input p-3 font-mono text-xs leading-relaxed focus:ring-2 focus:ring-default focus:outline-none"
            onChange={(event) => onChange(event.currentTarget.value)}
            readOnly={!editable}
            spellCheck={false}
            value={html}
          />
        </div>
      ) : html ? (
        <div className="flex-1 overflow-hidden p-4">
          {/*
           * `bg-white` rather than a surface token on purpose: this is the document's own canvas,
           * not app chrome. The markup inside was written for paper and mostly sets no background
           * of its own, so a dark surface behind it would leave black text on black in dark mode.
           */}
          <iframe
            className="border-default h-full w-full rounded border bg-white"
            sandbox=""
            srcDoc={html}
            title="HTML preview"
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-muted text-sm">No HTML output.</p>
        </div>
      )}
    </div>
  );
}
