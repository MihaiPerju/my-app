import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@mistralai/ui/collapsible";
import { TypographySpan } from "@mistralai/ui/typography";
import { useState } from "react";

type JsonInspectorProps = {
  value: unknown;
  label: string;
  defaultOpen?: boolean;
};

export function JsonInspector({ value, label, defaultOpen = false }: JsonInspectorProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      fullWidth
      variant="soft"
      className="border-default bg-card-subtle overflow-hidden rounded-card-md border"
    >
      <CollapsibleTrigger className="hover:bg-state-ghost-hover px-4 py-3 text-left transition-colors">
        <TypographySpan size="sm" weight="medium">
          {label}
        </TypographySpan>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {isOpen ? (
          <pre className="border-default bg-default text-default max-h-96 overflow-auto border-t p-4 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
            <code>{formatJson(value)}</code>
          </pre>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function formatJson(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2);
}
