"use client";

import { useMemo } from "react";

export interface TextViewerProps {
  text: string;
}

export function TextViewer({ text }: TextViewerProps) {
  const lines = useMemo(() => text.trimEnd().split(/\r?\n/), [text]);
  const lineNumberWidth = String(lines.length).length;

  return (
    <pre className="font-mono text-sm">
      <code>
        {lines.map((line, index) => (
          <div key={index} className="hover:bg-muted/40 flex">
            <span
              className="text-muted-foreground me-4 text-right select-none"
              style={{ minWidth: `${lineNumberWidth}ch` }}
            >
              {index + 1}
            </span>
            <span className="flex-1 break-all whitespace-pre-wrap">{line}</span>
          </div>
        ))}
      </code>
    </pre>
  );
}
